/** The preview service against sites that misbehave: bad lists, crashes, hangs, and code that should see little. */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPreviewServer, siteEnv } from "./preview.js";
import {
  createPreviewSitesServer,
  devCommand,
  hostname,
  type PreviewSitesOptions,
  SiteList,
} from "./previews.js";

let root: string;
let listFile: string;
const log: string[] = [];
const closers: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greatcms-preview-hardening-"));
  listFile = join(root, "sites.json");
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
  rmSync(root, { recursive: true, force: true });
  log.length = 0;
});

// The "dev server": says who it is, what it was sent, and can be told to die or to hang.
const SERVER = `
const http = require("node:http");
require("node:fs").writeFileSync("pid", String(process.pid));
http.createServer((req, res) => {
  if (req.url === "/die") process.exit(7);
  if (req.url === "/hang") return;
  if (req.url === "/env") return res.end(JSON.stringify(process.env));
  if (req.url === "/headers") return res.end(JSON.stringify(req.headers));
  if (req.url === "/hop") { res.setHeader("keep-alive", "timeout=1"); res.setHeader("x-kept", "1"); return res.end("hop"); }
  let size = 0;
  req.on("data", (chunk) => (size += chunk.length));
  req.on("end", () => res.end(NAME + " " + size));
}).listen(process.env.PORT, "127.0.0.1");
`;

function site(name: string, script = SERVER) {
  const path = join(root, name);
  mkdirSync(join(path, "node_modules"), { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
  writeFileSync(join(path, "server.js"), `const NAME = ${JSON.stringify(name)};${script}`);
  return path;
}

function list(sites: Array<{ host: string; path: string }>) {
  writeFileSync(`${listFile}.next`, JSON.stringify({ version: 1, sites }));
  // Renamed into place as the studio does, so each version is a new file.
  rmSync(listFile, { force: true });
  writeFileSync(listFile, readFileSync(`${listFile}.next`));
}

let nextPort = 5200 + Math.floor(Math.random() * 100) * 10;

async function up(overrides: Partial<PreviewSitesOptions> = {}) {
  const firstUpstream = (nextPort += 10);
  const started = createPreviewSitesServer({
    sitesFile: listFile,
    port: 0,
    firstUpstream,
    idle: 60,
    startTimeout: 20,
    log: (line) => log.push(line),
    ...overrides,
  });
  await new Promise<void>((resolve) => started.server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    for (const runner of started.sites.runners()) runner.killNow();
    started.server.close();
    started.server.closeAllConnections();
  });
  return { ...started, firstUpstream, port: (started.server.address() as AddressInfo).port };
}

function ask(
  port: number,
  host: string,
  path = "/",
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host, ...options.headers },
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const until = (check: () => boolean | Promise<boolean>, ms = 15000) =>
  expect.poll(check, { timeout: ms, interval: 100 }).toBe(true);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pidOf = (path: string) => Number(readFileSync(join(path, "pid"), "utf8"));

describe("the host a request names", () => {
  it("is one site however it is spelled, and never a pattern", () => {
    expect(hostname("Shop-Preview.Example.com.:443")).toBe("shop-preview.example.com");
    list([{ host: "Shop-Preview.example.com", path: "/srv/shop" }]);
    const sites = new SiteList(listFile);
    expect(sites.find("shop-preview.example.com.")?.path).toBe("/srv/shop");
    expect(sites.find("SHOP-PREVIEW.EXAMPLE.COM:8080")?.path).toBe("/srv/shop");
    expect(sites.find("shop-preview.example.com.evil.test")).toBeUndefined();
    expect(sites.find("")).toBeUndefined();
  });
});

describe("the list the studio writes", () => {
  it("keeps the last good list when the file turns to nonsense, and says so", () => {
    list([{ host: "a.example.com", path: "/srv/a" }]);
    const sites = new SiteList(listFile, (line) => log.push(line));
    expect(sites.current()).toHaveLength(1);

    for (const nonsense of ["{ half", "null", '{"sites":"all of them"}', "x".repeat(2_000_000)]) {
      rmSync(listFile);
      writeFileSync(listFile, nonsense);
      expect(sites.find("a.example.com")?.path).toBe("/srv/a");
    }
    expect(log.join("\n")).toMatch(/could not be read|ignored/);

    rmSync(listFile);
    expect(sites.current()).toEqual([]);
  });

  it("skips entries that are not a host and an absolute folder, and a name listed twice", () => {
    writeFileSync(
      listFile,
      JSON.stringify({
        sites: [
          null,
          { host: "good.example.com", path: "/srv/good" },
          { host: "good.example.com", path: "/srv/impostor" },
          { host: "bad host", path: "/srv/x" },
          { host: "*.example.com", path: "/srv/x" },
          { host: "relative.example.com", path: "sites/x" },
          { host: 7, path: "/srv/x" },
        ],
      }),
    );
    const sites = new SiteList(listFile);
    expect(sites.current().map((entry) => entry.path)).toEqual(["/srv/good"]);
  });
});

describe("a package.json nobody vetted", () => {
  it("is never fatal, and nothing in it becomes part of the command", () => {
    const strange = (name: string, content: string) => {
      const path = join(root, name);
      mkdirSync(join(path, "node_modules"), { recursive: true });
      writeFileSync(join(path, "package.json"), content);
      return devCommand(path);
    };
    expect(strange("null", "null")).toHaveProperty("problem");
    expect(strange("list", "[]")).toHaveProperty("problem");
    expect(strange("text", '{"dependencies":"astro","scripts":{"dev":["x"]}}')).toHaveProperty(
      "problem",
    );
    expect(strange("proto", '{"dependencies":{"__proto__":{"astro":"1"}}}')).toHaveProperty(
      "problem",
    );
    const injected = strange(
      "inject",
      JSON.stringify({
        name: "$(touch /tmp/owned)",
        dependencies: { "astro; touch /tmp/owned": "1", vite: "`touch /tmp/owned`" },
        scripts: { dev: "x" },
      }),
    );
    expect(injected).toEqual({
      command: 'exec node_modules/.bin/vite dev --host 127.0.0.1 --port "$PORT" --strictPort',
    });
  });

  it("installs without lifecycle scripts when asked to", () => {
    const path = join(root, "fresh");
    mkdirSync(path);
    writeFileSync(join(path, "package.json"), JSON.stringify({ dependencies: { astro: "5" } }));
    writeFileSync(join(path, "package-lock.json"), "{}");
    expect(devCommand(path, { ignoreScripts: true })).toEqual({
      command: expect.stringMatching(/^npm ci --ignore-scripts && exec /),
    });
  });
});

describe("what a site's code is given", () => {
  it("sees the tools' environment and public names, and nothing else of the service's", async () => {
    expect(
      siteEnv(
        {
          PATH: "/bin",
          HOME: "/home/node",
          PUBLIC_CMS_URL: "https://studio.example.com",
          ASTRO_TELEMETRY_DISABLED: "1",
          STUDIO_SECRET: "s",
          CLOUDFLARE_TUNNEL_TOKEN: "t",
          NPM_TOKEN: "n",
          DATABASE_URL: "d",
        },
        ["NPM_TOKEN"],
      ),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/node",
      PUBLIC_CMS_URL: "https://studio.example.com",
      ASTRO_TELEMETRY_DISABLED: "1",
      NPM_TOKEN: "n",
    });

    process.env.GREATCMS_TEST_SECRET = "do not leak";
    list([{ host: "env.example.com", path: site("env") }]);
    const { port } = await up();
    await until(async () => (await ask(port, "env.example.com")).status === 200);
    const seen = JSON.parse((await ask(port, "env.example.com", "/env")).body);
    delete process.env.GREATCMS_TEST_SECRET;
    expect(seen.GREATCMS_TEST_SECRET).toBeUndefined();
    expect(seen.PREVIEW_HOST).toBe("env.example.com");
    expect(seen.HOST).toBe("127.0.0.1");
  }, 30000);

  it("never receives the studio's cookies or one connection's own headers", async () => {
    list([{ host: "cookie.example.com", path: site("cookie") }]);
    const { port } = await up();
    await until(async () => (await ask(port, "cookie.example.com")).status === 200);

    const seen = JSON.parse(
      (
        await ask(port, "cookie.example.com", "/headers", {
          headers: {
            cookie: "theme=dark; greatcms_preview=signed; greatcms_share=token; cart=3",
            connection: "x-private, keep-alive",
            "x-private": "for the proxy only",
            "x-forwarded-for": "203.0.113.9",
          },
        })
      ).body,
    );
    expect(seen.cookie).toBe("theme=dark; cart=3");
    expect(seen["x-private"]).toBeUndefined();
    expect(seen["x-forwarded-for"]).toBe("203.0.113.9");

    const only = await ask(port, "cookie.example.com", "/headers", {
      headers: { cookie: "greatcms_preview=signed" },
    });
    expect(JSON.parse(only.body).cookie).toBeUndefined();

    const back = await ask(port, "cookie.example.com", "/hop");
    expect(back.headers["x-kept"]).toBe("1");
    expect(back.headers["keep-alive"]).not.toBe("timeout=1");
  }, 30000);

  it("refuses a body larger than it passes on", async () => {
    list([{ host: "big.example.com", path: site("big") }]);
    const { port } = await up({ maxBody: 1000 });
    await until(async () => (await ask(port, "big.example.com")).status === 200);

    const small = await ask(port, "big.example.com", "/", {
      method: "POST",
      body: "x".repeat(900),
    });
    expect(small.body).toBe("big 900");
    const large = await ask(port, "big.example.com", "/", {
      method: "POST",
      body: "x".repeat(5000),
    });
    expect(large.status).toBe(413);
  }, 30000);
});

describe("ports", () => {
  it("never sends a site's visitors to whatever else holds its port", async () => {
    list([{ host: "mine.example.com", path: site("mine") }]);
    const { port, firstUpstream } = await up();
    const squatter = createServer((_, res) => res.end("someone else"));
    await new Promise<void>((resolve) => squatter.listen(firstUpstream, "127.0.0.1", resolve));
    closers.push(() => squatter.close());

    await until(async () => (await ask(port, "mine.example.com")).status === 200);
    expect((await ask(port, "mine.example.com")).body).toBe("mine 0");
    expect(log.join("\n")).toContain("is taken; trying another");
  }, 30000);

  it("moves a name to another folder without the old dev server answering for the new", async () => {
    const one = site("one");
    list([{ host: "moved.example.com", path: one }]);
    const { port } = await up();
    await until(async () => (await ask(port, "moved.example.com")).body === "one 0");
    const old = pidOf(one);

    list([{ host: "moved.example.com", path: site("two") }]);
    await until(async () => (await ask(port, "moved.example.com")).body === "two 0");
    expect(alive(old)).toBe(false);
  }, 30000);
});

describe("a dev server that fails", () => {
  it("is not started again on every reload while it keeps failing", async () => {
    list([{ host: "broken.example.com", path: site("broken", "process.exit(3);") }]);
    const { port, sites } = await up();
    await ask(port, "broken.example.com");
    await until(() => sites.status()[0]?.state === "stopped" && !!sites.status()[0]?.failure);

    await Promise.all(Array.from({ length: 5 }, () => ask(port, "broken.example.com")));
    expect(log.filter((line) => line.includes("starting:"))).toHaveLength(1);
    const page = await ask(port, "broken.example.com");
    expect(page.body).toContain("The preview did not start");
    expect(page.body).toContain("tried again in");
    expect(page.body).not.toContain("http-equiv");

    const status = JSON.parse((await ask(port, "broken.example.com", "/__greatcms/preview")).body);
    expect(status.retryInSeconds).toBeGreaterThan(0);
    // Asked for again once the wait is over.
    await until(async () => {
      await ask(port, "broken.example.com");
      return log.filter((line) => line.includes("starting:")).length === 2;
    });
  }, 30000);

  it("comes back after dying under an editor", async () => {
    const path = site("mortal");
    list([{ host: "mortal.example.com", path }]);
    const { port } = await up();
    await until(async () => (await ask(port, "mortal.example.com")).status === 200);
    const first = pidOf(path);

    await ask(port, "mortal.example.com", "/die").catch(() => undefined);
    await until(() => !alive(first));
    await until(async () => (await ask(port, "mortal.example.com")).status === 200);
    expect(pidOf(path)).not.toBe(first);
    expect(log.join("\n")).toContain("[mortal.example.com] dev server exited (7)");
  }, 30000);

  it("is restarted when it takes requests and answers none", async () => {
    const path = site("hung");
    list([{ host: "hung.example.com", path }]);
    const { port } = await up({ upstreamTimeout: 1 });
    await until(async () => (await ask(port, "hung.example.com")).status === 200);
    const first = pidOf(path);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const answer = await ask(port, "hung.example.com", "/hang");
    expect(answer.status).toBe(504);
    expect(answer.body).toContain("not answering");
    expect(log.join("\n")).toContain("stopped answering");
    await until(() => !alive(first));
    await until(async () => (await ask(port, "hung.example.com")).status === 200);
  }, 30000);
});

describe("stopping", () => {
  it("leaves one dev server, not two, when a request arrives as the last one is stopping", async () => {
    const path = site("again");
    list([{ host: "again.example.com", path }]);
    const { port, sites } = await up();
    await until(async () => (await ask(port, "again.example.com")).status === 200);
    const first = pidOf(path);

    const [runner] = sites.runners();
    runner?.stop();
    await ask(port, "again.example.com");
    expect(sites.status()[0]?.state).toBe("starting");
    await until(async () => (await ask(port, "again.example.com")).status === 200);
    expect(alive(first)).toBe(false);
    expect(sites.status()[0]?.state).toBe("running");
    expect(log.filter((line) => line.includes("starting:"))).toHaveLength(2);
  }, 30000);

  it("stops the longest unused dev server to make room for one more", async () => {
    list([
      { host: "a.example.com", path: site("a") },
      { host: "b.example.com", path: site("b") },
      { host: "c.example.com", path: site("c") },
    ]);
    const { port, sites } = await up({ maxRunning: 2 });
    await until(async () => (await ask(port, "a.example.com")).status === 200);
    await until(async () => (await ask(port, "b.example.com")).status === 200);
    await until(async () => (await ask(port, "c.example.com")).status === 200);

    expect(sites.status().map((entry) => entry.state)).toEqual(["stopped", "running", "running"]);
    expect(log.join("\n")).toContain("[a.example.com] stopped to make room for c.example.com");
  }, 30000);

  it("kills what ignores being asked, and everything the command started", async () => {
    const stubborn = `
      process.on("SIGTERM", () => {});
      const child = require("node:child_process").spawn("sleep", ["600"], { stdio: "ignore" });
      require("node:fs").writeFileSync("child", String(child.pid));
    ${SERVER}`;
    const path = site("stubborn", stubborn);
    const preview = createPreviewServer({
      source: path,
      command: "node server.js",
      port: 0,
      upstreamPort: (nextPort += 10),
      idle: 60,
      startTimeout: 20,
      log: (line) => log.push(line),
    });
    await new Promise<void>((resolve) => preview.server.listen(0, "127.0.0.1", resolve));
    closers.push(() => {
      preview.runner.killNow();
      preview.server.close();
      preview.server.closeAllConnections();
    });
    const { port } = preview.server.address() as AddressInfo;
    await until(async () => (await ask(port, "x")).status === 200);
    const pids = [pidOf(path), Number(readFileSync(join(path, "child"), "utf8"))];

    preview.runner.stop();
    await preview.runner.gone();
    await until(() => !pids.some(alive), 3000);
  }, 30000);

  it("takes every dev server with it when the service is told to stop", async () => {
    const path = site("service");
    const bin = fileURLToPath(new URL("../bin/greatcms-preview.mjs", import.meta.url));
    const proxyPort = (nextPort += 10);
    const service = spawn(process.execPath, [bin], {
      env: {
        PATH: process.env.PATH,
        PREVIEW_SOURCE: path,
        PREVIEW_COMMAND: "node server.js",
        PREVIEW_PORT: String(proxyPort),
        PREVIEW_BIND: "127.0.0.1",
        PREVIEW_UPSTREAM: String(proxyPort + 1),
      },
      stdio: "ignore",
    });
    closers.push(() => service.kill("SIGKILL"));
    const exit = new Promise<number | null>((resolve) => service.on("exit", resolve));

    await until(async () => {
      const health = await ask(proxyPort, "x", "/__greatcms/health").catch(() => null);
      return health?.status === 200;
    });
    await until(async () => (await ask(proxyPort, "x")).status === 200);
    const pid = pidOf(path);
    expect(alive(pid)).toBe(true);

    service.kill("SIGTERM");
    expect(await exit).toBe(0);
    expect(alive(pid)).toBe(false);
    expect(existsSync(path)).toBe(true);
  }, 30000);
});
