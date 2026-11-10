/** `greatcms studio`: what it decides before a studio starts, and the dev server it runs beside it. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./index.js";
import {
  answers,
  choosePort,
  DEFAULT_PORT,
  type DevServer,
  type DevServerOptions,
  devPlan,
  findSiteRoot,
  installCommand,
  isLoopback,
  nodeAtLeast,
  portFree,
  recordedDevUrls,
  resolveStudio,
  startDevServer,
  stateDir,
  studioCommand,
  type StudioDeps,
  type StudioModule,
} from "./studio.js";
import { parseFlags } from "./commands.js";
import type { PromptPort } from "./prompt.js";

let root: string;
const servers: Server[] = [];

function write(path: string, content = ""): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A site with a schema and, when asked, a framework whose binary is a file that exists. */
function site(framework?: "astro" | "next" | "nuxt" | "vite"): void {
  write(".cms/schema.yaml", "version: 1\nregions: {}\n");
  if (!framework) return;
  write(
    "package.json",
    JSON.stringify({ name: "@acme/my-site", dependencies: { [framework]: "1" } }),
  );
  write(`node_modules/.bin/${framework}`, "");
}

function listen(port = 0): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => response.end("ok")).listen(
      port,
      "127.0.0.1",
      () => resolve((server.address() as { port: number }).port),
    );
    servers.push(server);
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "greatcms-studio-cmd-")));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  rmSync(root, { recursive: true, force: true });
});

describe("finding the site", () => {
  it("walks up to the folder that holds the schema", () => {
    site();
    mkdirSync(join(root, "src/pages/blog"), { recursive: true });
    expect(findSiteRoot(join(root, "src/pages/blog"))).toBe(root);
    expect(findSiteRoot(root)).toBe(root);
  });

  it("accepts every spelling of the schema file", () => {
    write(".cms/schema.json", "{}");
    expect(findSiteRoot(root)).toBe(root);
  });

  it("finds nothing where there is no schema above", () => {
    expect(findSiteRoot(root)).toBeNull();
  });
});

describe("where state goes", () => {
  it("is node_modules/.cache when the site has node_modules", () => {
    mkdirSync(join(root, "node_modules"));
    expect(stateDir(root, {}, "linux", "/home/me")).toBe(
      join(root, "node_modules", ".cache", "greatcms"),
    );
  });

  it("is the OS cache otherwise, one folder per site, never inside the site", () => {
    const linux = stateDir(root, {}, "linux", "/home/me");
    expect(linux.startsWith("/home/me/.cache/greatcms/")).toBe(true);
    expect(stateDir(root, { XDG_CACHE_HOME: "/x" }, "linux", "/home/me").startsWith("/x/")).toBe(
      true,
    );
    expect(stateDir(root, {}, "darwin", "/Users/me")).toContain("/Users/me/Library/Caches/");
    expect(stateDir(root, { LOCALAPPDATA: "C:\\L" }, "win32", "C:\\me")).toContain("C:\\L");
    expect(stateDir(`${root}-other`, {}, "linux", "/home/me")).not.toBe(linux);
    expect(linux.startsWith(root)).toBe(false);
  });
});

describe("choosing a port", () => {
  it("takes the default when it is free, and the next free one when it is not", async () => {
    expect(await choosePort(DEFAULT_PORT, async () => true)).toBe(4983);
    const busy = new Set([4983, 4984]);
    expect(await choosePort(DEFAULT_PORT, async (port) => !busy.has(port))).toBe(4985);
  });

  it("skips a port already promised to something else", async () => {
    expect(await choosePort(3000, async () => true, new Set([3000]))).toBe(3001);
  });

  it("gives up with a fix rather than scanning forever", async () => {
    await expect(choosePort(4983, async () => false)).rejects.toThrow(/--port/);
  });

  it("sees a real listener as busy", async () => {
    const port = await listen();
    expect(await portFree(port)).toBe(false);
    expect(await answers(`http://127.0.0.1:${port}`)).toBe(true);
  });
});

describe("the dev server to start", () => {
  it("knows each framework's command and usual port", () => {
    site("astro");
    const astro = devPlan(root);
    if ("problem" in astro) throw new Error(astro.problem);
    expect(astro.port).toBe(4321);
    expect(astro.command(4400)).toEqual([
      join(root, "node_modules/.bin/astro"),
      "dev",
      "--port",
      "4400",
      "--ignore-lock",
    ]);
    expect(astro.recordsItself).toBe(false);
  });

  it("keeps Next on this machine", () => {
    site("next");
    const next = devPlan(root);
    if ("problem" in next) throw new Error(next.problem);
    expect(next.port).toBe(3000);
    expect(next.command(3001).slice(1)).toEqual([
      "dev",
      "--hostname",
      "localhost",
      "--port",
      "3001",
    ]);
  });

  it("falls back to Vite for a site that only has that", () => {
    site("vite");
    const vite = devPlan(root);
    if ("problem" in vite) throw new Error(vite.problem);
    expect(vite.label).toBe("vite dev");
    expect(vite.command(5173).slice(1)).toEqual(["dev", "--port", "5173", "--strictPort"]);
  });

  it("finds the binary in a workspace root above the site", () => {
    write("node_modules/.bin/astro", "");
    const app = join(root, "apps/web");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { astro: "1" } }));
    const plan = devPlan(app);
    if ("problem" in plan) throw new Error(plan.problem);
    expect(plan.command(1)[0]).toBe(join(root, "node_modules/.bin/astro"));
  });

  it("says why when there is nothing to start", () => {
    site();
    expect(devPlan(root)).toEqual({ problem: expect.stringContaining("no package.json") });
    write("package.json", JSON.stringify({ dependencies: { express: "1" } }));
    expect(devPlan(root)).toEqual({ problem: expect.stringContaining("no Astro") });
    write("package.json", JSON.stringify({ dependencies: { astro: "1" } }));
    expect(devPlan(root)).toEqual({ problem: expect.stringContaining("not installed") });
  });

  it("trusts Astro's own record once the installed Astro keeps one", () => {
    site("astro");
    write("node_modules/astro/dist/core/dev/lockfile.js", "");
    const plan = devPlan(root);
    expect("problem" in plan ? null : plan.recordsItself).toBe(true);
  });
});

describe("a dev server that says where it is", () => {
  it("reads Astro's and Next's records, for a process that is still alive", () => {
    site("astro");
    write(".astro/dev.json", JSON.stringify({ pid: process.pid, url: "http://localhost:4400/" }));
    write("dist/dev/lock", JSON.stringify({ pid: process.pid, appUrl: "http://localhost:3005" }));
    expect(recordedDevUrls(root)).toEqual(["http://localhost:4400", "http://localhost:3005"]);
  });

  it("ignores a record left by a process that has gone, or one that is not an address", () => {
    site("astro");
    write(".astro/dev.json", JSON.stringify({ pid: 2 ** 30, url: "http://localhost:4400" }));
    write(".next/dev/lock", JSON.stringify({ pid: process.pid, appUrl: "javascript:alert(1)" }));
    write("out/dev/lock", "not json");
    expect(recordedDevUrls(root)).toEqual([]);
  });
});

describe("running the dev command", () => {
  /** A stand-in dev server: listens on the port it is given, and starts a child of its own. */
  const FAKE = `
    const { createServer } = require("node:http");
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(process.argv[3], String(worker.pid));
    console.log("fake dev server starting");
    createServer((_q, r) => r.end("site")).listen(Number(process.argv[2]), "127.0.0.1");
  `;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("is ready once the address answers, and stops with everything it started", async () => {
    write("fake.cjs", FAKE);
    const port = await choosePort(46_200);
    const dev = startDevServer({
      command: [process.execPath, join(root, "fake.cjs"), String(port), join(root, "worker.pid")],
      cwd: root,
      url: `http://127.0.0.1:${port}`,
    });
    expect(await dev.ready).toBe(true);
    expect(dev.tail()).toContain("fake dev server starting");
    const { readFileSync } = await import("node:fs");
    const worker = Number(readFileSync(join(root, "worker.pid"), "utf8"));
    expect(alive(worker)).toBe(true);

    await dev.stop();
    expect(await answers(`http://127.0.0.1:${port}`)).toBe(false);
    // The dev server's own child went with it: the whole process group was signalled.
    await expect.poll(() => alive(worker), { timeout: 3000 }).toBe(false);
    await dev.stop();
  });

  it("reports a command that exits instead of waiting out the clock", async () => {
    const began = Date.now();
    const dev = startDevServer({
      command: [process.execPath, "-e", "console.error('port in use'); process.exit(1)"],
      cwd: root,
      url: "http://127.0.0.1:9",
      timeoutMs: 30_000,
    });
    expect(await dev.ready).toBe(false);
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(dev.tail()).toContain("port in use");
    await dev.stop();
  });

  it("gives up on a command that never listens", async () => {
    const dev = startDevServer({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      url: "http://127.0.0.1:9",
      timeoutMs: 400,
    });
    expect(await dev.ready).toBe(false);
    await dev.stop();
  });

  it("kills one that ignores being asked", async () => {
    write("stubborn.cjs", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    const dev = startDevServer({
      command: [process.execPath, join(root, "stubborn.cjs")],
      cwd: root,
      url: "http://127.0.0.1:9",
      timeoutMs: 300,
      killAfterMs: 200,
    });
    await dev.ready;
    const began = Date.now();
    await dev.stop();
    expect(Date.now() - began).toBeLessThan(5000);
  });

  it("survives a command that does not exist", async () => {
    const dev = startDevServer({
      command: [join(root, "no-such-binary")],
      cwd: root,
      url: "http://127.0.0.1:9",
    });
    expect(await dev.ready).toBe(false);
    await dev.stop();
  });
});

describe("finding and installing the studio", () => {
  it("prefers the site's own copy", () => {
    site("astro");
    write(
      "node_modules/@greatcms/studio/package.json",
      JSON.stringify({ name: "@greatcms/studio", type: "module", exports: { ".": "./start.js" } }),
    );
    write("node_modules/@greatcms/studio/start.js", "export {};");
    expect(resolveStudio(root)).toBe(join(root, "node_modules/@greatcms/studio/start.js"));
  });

  it("names the exact command, in the site's package manager", () => {
    site("astro");
    expect(installCommand(root).join(" ")).toBe("npm install --save-dev @greatcms/studio");
    write("pnpm-lock.yaml", "");
    expect(installCommand(root).join(" ")).toBe("pnpm add -D @greatcms/studio");
    rmSync(join(root, "pnpm-lock.yaml"));
    write("yarn.lock", "");
    expect(installCommand(root).join(" ")).toBe("yarn add -D @greatcms/studio");
  });

  it("installs globally for a site with no package.json", () => {
    site();
    expect(installCommand(root).join(" ")).toBe("npm install --global @greatcms/studio");
  });
});

describe("small decisions", () => {
  it("compares Node versions as numbers", () => {
    expect(nodeAtLeast("22.13.0")).toBe(true);
    expect(nodeAtLeast("22.12.9")).toBe(false);
    expect(nodeAtLeast("20.19.0")).toBe(false);
    expect(nodeAtLeast("24.0.0")).toBe(true);
    expect(nodeAtLeast("22.100.0")).toBe(true);
  });

  it("knows loopback from the network", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"])
      expect(isLoopback(host)).toBe(true);
    for (const host of ["0.0.0.0", "::", "192.168.0.2", "my-laptop.local"])
      expect(isLoopback(host)).toBe(false);
  });
});

describe("the command", () => {
  const out: string[] = [];
  const err: string[] = [];
  let started: Array<Parameters<StudioModule["startLocal"]>[0]>;
  let devStarted: DevServerOptions[];
  let stopped: string[];
  let opened: string[];

  const fakeStudio = (): StudioModule => ({
    async startLocal(options) {
      started.push(options);
      return {
        port: options.port,
        url: `http://127.0.0.1:${options.port}/sites/my-site`,
        signInUrl: options.password
          ? undefined
          : `http://127.0.0.1:${options.port}/local/sign-in?token=abc`,
        close: async () => void stopped.push("studio"),
      };
    },
  });

  const fakeDev = (options: DevServerOptions): DevServer => {
    devStarted.push(options);
    return {
      ready: Promise.resolve(true),
      tail: () => "",
      stop: async () => void stopped.push("dev"),
    };
  };

  const deps = (overrides: Partial<StudioDeps> = {}): Partial<StudioDeps> => ({
    env: {},
    nodeVersion: "22.13.0",
    load: async () => fakeStudio(),
    install: async () => 0,
    portFree: async () => true,
    answers: async () => false,
    startDev: fakeDev,
    open: (url) => void opened.push(url),
    stopped: async () => {},
    ...overrides,
  });

  const studio = (argv: string[], overrides: Partial<StudioDeps> = {}, prompt?: PromptPort) =>
    studioCommand(
      {
        cwd: root,
        flags: parseFlags(argv),
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        prompt,
      },
      deps(overrides),
    );

  beforeEach(() => {
    out.length = 0;
    err.length = 0;
    started = [];
    devStarted = [];
    stopped = [];
    opened = [];
  });

  it("starts the studio on loopback for this folder, starts the dev server, and stops both", async () => {
    site("astro");
    expect(await studio([])).toBe(0);

    expect(started).toEqual([
      {
        root,
        name: "my-site",
        stateDir: join(root, "node_modules/.cache/greatcms"),
        port: 4983,
        host: "127.0.0.1",
        devUrl: "http://localhost:4321",
        password: undefined,
      },
    ]);
    expect(devStarted[0]?.command.slice(1)).toEqual(["dev", "--port", "4321", "--ignore-lock"]);
    expect(devStarted[0]?.cwd).toBe(root);
    expect(opened).toEqual(["http://127.0.0.1:4983/local/sign-in?token=abc"]);
    expect(stopped.toSorted()).toEqual(["dev", "studio"]);

    const text = out.join("");
    expect(text).toContain("http://127.0.0.1:4983");
    expect(text).toContain("http://localhost:4321");
    expect(text).toContain("/local/sign-in?token=abc");
    expect(text).toContain(root);
    expect(text.split("\n").length).toBeLessThan(16);
    expect(text).not.toContain("\u2014");
  });

  it("works from a folder inside the site", async () => {
    site("astro");
    mkdirSync(join(root, "src/pages"), { recursive: true });
    await studioCommand(
      { cwd: join(root, "src/pages"), flags: parseFlags([]), stdout: () => {}, stderr: () => {} },
      deps(),
    );
    expect(started[0]?.root).toBe(root);
  });

  it("says how to set a site up when there is none", async () => {
    await expect(studio([])).rejects.toThrow(/No \.cms\/schema\.yaml[\s\S]*greatcms init/);
    expect(started).toEqual([]);
  });

  it("says plainly when Node is too old, before anything else", async () => {
    await expect(studio([], { nodeVersion: "20.11.1" })).rejects.toThrow(
      /needs Node\.js 22\.13 or newer, and this is v20\.11\.1[\s\S]*fix:/,
    );
  });

  it("does not open a browser with --no-open, and still prints the link", async () => {
    site("astro");
    await studio(["--no-open"]);
    expect(opened).toEqual([]);
    expect(out.join("")).toContain("/local/sign-in?token=abc");
  });

  it("uses --port exactly, and refuses one that is taken", async () => {
    site("astro");
    await studio(["--port", "5000"]);
    expect(started[0]?.port).toBe(5000);
    await expect(studio(["--port", "5000"], { portFree: async () => false })).rejects.toThrow(
      /Port 5000 is in use/,
    );
    for (const bad of ["0", "70000", "abc", "49.5"]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
      await expect(studio(["--port", bad])).rejects.toThrow(/--port cannot be/);
    }
  });

  it("moves to the next free port when the default is taken", async () => {
    site("astro");
    await studio([], { portFree: async (port) => port !== 4983 && port !== 4321 });
    expect(started[0]?.port).toBe(4984);
    expect(started[0]?.devUrl).toBe("http://localhost:4322");
  });

  it("uses a dev server that is already answering on the usual port, and starts none", async () => {
    site("next");
    await studio([], { answers: async (url) => url === "http://localhost:3000" });
    expect(devStarted).toEqual([]);
    expect(started[0]?.devUrl).toBe("http://localhost:3000");
    expect(stopped).toEqual(["studio"]);
    expect(out.join("")).toContain("already running");
  });

  it("prefers the address the site's own dev server recorded over the usual port", async () => {
    site("next");
    write("dist/dev/lock", JSON.stringify({ pid: process.pid, appUrl: "http://localhost:3007" }));
    await studio([], { answers: async () => true });
    expect(started[0]?.devUrl).toBe("http://localhost:3007");
    expect(devStarted).toEqual([]);
  });

  it("does not mistake another site on Astro's port for this one", async () => {
    site("astro");
    write("node_modules/astro/dist/core/dev/lockfile.js", "");
    await studio([], {
      answers: async (url) => url === "http://localhost:4321",
      portFree: async (port) => port !== 4321,
    });
    expect(started[0]?.devUrl).toBe("http://localhost:4322");
    expect(devStarted).toHaveLength(1);
  });

  it("takes --dev-url as given and starts nothing", async () => {
    site("astro");
    await studio(["--dev-url", "http://localhost:9999/"]);
    expect(started[0]?.devUrl).toBe("http://localhost:9999");
    expect(devStarted).toEqual([]);
    await expect(studio(["--dev-url", "localhost:9999"])).rejects.toThrow(/--dev-url cannot be/);
  });

  it("starts and looks for nothing with --no-dev", async () => {
    site("astro");
    let probed = 0;
    await studio(["--no-dev"], {
      answers: async () => {
        probed += 1;
        return true;
      },
    });
    expect(probed).toBe(0);
    expect(devStarted).toEqual([]);
    expect(started[0]?.devUrl).toBeUndefined();
  });

  it("still opens the editor for a site with no dev server to start", async () => {
    site();
    expect(await studio([])).toBe(0);
    expect(started[0]?.devUrl).toBeUndefined();
    expect(out.join("")).toContain("--dev-url");
  });

  it("refuses a host that is not loopback without a password, and says why", async () => {
    site("astro");
    await expect(studio(["--host", "0.0.0.0"])).rejects.toThrow(
      /no password[\s\S]*only safe on this machine[\s\S]*STUDIO_PASSWORD/,
    );
    expect(started).toEqual([]);
    expect(devStarted).toEqual([]);
  });

  it("with a password, listens there and offers no link", async () => {
    site("astro");
    await studio(["--host", "0.0.0.0"], { env: { STUDIO_PASSWORD: "long and random" } });
    expect(started[0]?.host).toBe("0.0.0.0");
    expect(started[0]?.password).toBe("long and random");
    expect(opened).toEqual([]);
    expect(out.join("")).toContain("STUDIO_PASSWORD");
    expect(out.join("")).not.toContain("long and random");
  });

  it("never hands the password to a loopback studio, which signs in by link", async () => {
    site("astro");
    await studio(["--host", "localhost"], { env: { STUDIO_PASSWORD: "long and random" } });
    expect(started[0]?.password).toBeUndefined();
  });

  it("stops the dev server when the studio cannot start", async () => {
    site("astro");
    const failing: StudioModule = {
      startLocal: async () => {
        throw new Error("database is locked");
      },
    };
    await expect(studio([], { load: async () => failing })).rejects.toThrow(/database is locked/);
    expect(stopped).toEqual(["dev"]);
  });

  describe("when the studio is not installed", () => {
    const prompt = (answer: boolean): PromptPort & { asked: string[] } => {
      const asked: string[] = [];
      return {
        asked,
        interactive: true,
        note: () => {},
        select: async () => {
          throw new Error("not asked");
        },
        text: async () => "",
        confirm: async (question) => {
          asked.push(question);
          return answer;
        },
      };
    };

    it("without a terminal, installs nothing and prints the exact command", async () => {
      site("astro");
      const installs: string[][] = [];
      await expect(
        studio([], {
          load: async () => null,
          install: async (command) => {
            installs.push(command);
            return 0;
          },
        }),
      ).rejects.toThrow(/not installed[\s\S]*npm install --save-dev @greatcms\/studio/);
      expect(installs).toEqual([]);
    });

    it("asks first, and installs nothing on a no", async () => {
      site("astro");
      const installs: string[][] = [];
      const asking = prompt(false);
      await expect(
        studio(
          [],
          {
            load: async () => null,
            install: async (command) => {
              installs.push(command);
              return 0;
            },
          },
          asking,
        ),
      ).rejects.toThrow(/Nothing was installed/);
      expect(asking.asked).toEqual(["Install it now?"]);
      expect(installs).toEqual([]);
      expect(out.join("")).toContain("npm install --save-dev @greatcms/studio");
    });

    it("on a yes, runs that command in the site and carries on", async () => {
      site("astro");
      const installs: Array<[string[], string]> = [];
      let installed = false;
      await studio(
        [],
        {
          load: async () => (installed ? fakeStudio() : null),
          install: async (command, cwd) => {
            installs.push([command, cwd]);
            installed = true;
            return 0;
          },
        },
        prompt(true),
      );
      expect(installs).toEqual([[["npm", "install", "--save-dev", "@greatcms/studio"], root]]);
      expect(started).toHaveLength(1);
    });

    it("reports an install that fails", async () => {
      site("astro");
      await expect(
        studio([], { load: async () => null, install: async () => 1 }, prompt(true)),
      ).rejects.toThrow(/failed/);
    });

    it("says so when the installed studio predates this command", async () => {
      site("astro");
      await expect(studio([], { load: async () => ({}) as StudioModule })).rejects.toThrow(
        /too old[\s\S]*@greatcms\/studio@latest/,
      );
    });
  });
});

describe("through the CLI", () => {
  const cli = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run({
      argv,
      cwd: root,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });
    return { code, out: out.join(""), err: err.join("") };
  };

  it("documents itself", async () => {
    const help = await cli(["studio", "--help"]);
    expect(help.code).toBe(0);
    for (const flag of ["--port", "--host", "--dev-url", "--no-dev", "--no-open"])
      expect(help.out).toContain(flag);
    expect(help.out).toContain("4983");
    expect((await cli(["--help"])).out).toContain("studio");
  });

  it("exits 1 with the fix where there is no site", async () => {
    const result = await cli(["studio", "--no-open"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("greatcms init");
  });

  it("exits 2 for a flag it does not take, an argument, or a network host with no password", async () => {
    site("astro");
    expect((await cli(["studio", "--prot", "5000"])).code).toBe(2);
    expect((await cli(["studio", "extra"])).code).toBe(2);
    expect((await cli(["studio", "--port"])).code).toBe(2);
    const saved = process.env.STUDIO_PASSWORD;
    delete process.env.STUDIO_PASSWORD;
    try {
      const refused = await cli(["studio", "--host", "0.0.0.0"]);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain("STUDIO_PASSWORD");
    } finally {
      if (saved !== undefined) process.env.STUDIO_PASSWORD = saved;
    }
  });
});
