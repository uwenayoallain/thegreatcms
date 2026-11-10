/** `greatcms studio` end to end: the real CLI, the built studio as an installed package, a real site. */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, makeSite } from "./site.js";

const STUDIO = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("../../../packages/cli/bin/greatcms.mjs", import.meta.url));

const SCHEMA = `version: 1
regions:
  home.hero:
    label: Hero
    fields:
      heading: { type: text, default: Hello }
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let site: Fixture;
let child: ChildProcess | undefined;

beforeEach(() => {
  site = makeSite({ schema: SCHEMA });
  site.store.close();
  site.write("package.json", JSON.stringify({ name: "command-site", private: true }));
  site.write(".gitignore", "node_modules\n");
  // Installed the way a package manager would leave it: the site's own node_modules.
  mkdirSync(join(site.root, "node_modules/@greatcms"), { recursive: true });
  symlinkSync(STUDIO, join(site.root, "node_modules/@greatcms/studio"), "dir");
  site.git(["add", "-A"]);
  site.git(["commit", "-qm", "site"]);
});

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  site.cleanup();
});

/** Runs the command and resolves with what it has printed once `pattern` shows up. */
function start(args: string[]): {
  seen(pattern: RegExp): Promise<RegExpMatchArray>;
  exit: Promise<number | null>;
  output(): string;
} {
  let output = "";
  const { STUDIO_PASSWORD: _password, ...env } = process.env;
  const running = spawn(process.execPath, [CLI, "studio", ...args], {
    cwd: join(site.root, ".cms"),
    env: { ...env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = running;
  running.stdout.on("data", (chunk) => (output += String(chunk)));
  running.stderr.on("data", (chunk) => (output += String(chunk)));
  const exit = new Promise<number | null>((done) => running.once("exit", (code) => done(code)));
  return {
    exit,
    output: () => output,
    async seen(pattern) {
      for (let waited = 0; waited < 20_000; waited += 25) {
        const match = output.match(pattern);
        if (match) return match;
        if (running.exitCode !== null) break;
        // oxlint-disable-next-line no-await-in-loop -- polling the child's output
        await new Promise((wake) => setTimeout(wake, 25));
      }
      throw new Error(`"${pattern}" never appeared in:\n${output}`);
    },
  };
}

describe("greatcms studio", () => {
  it("opens the editor for this folder through the one-time link, and stops cleanly", async () => {
    expect(existsSync(join(STUDIO, "dist/start.js")), "run `pnpm build` first").toBe(true);
    const port = await freePort();
    const run = start(["--no-open", "--no-dev", "--port", String(port)]);

    const [link] = await run.seen(/http:\/\/127\.0\.0\.1:\d+\/local\/sign-in\?token=[\w-]+/);
    expect(link).toContain(`:${port}/`);
    expect(run.output()).toContain(site.root);
    expect(run.output()).not.toContain("ExperimentalWarning");

    const signIn = await fetch(link as string, { redirect: "manual" });
    expect(signIn.status).toBe(303);
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const landing = new URL(signIn.headers.get("location") as string, link).href;
    expect(landing).toBe(`http://127.0.0.1:${port}/sites/command-site`);

    const overview = await fetch(landing, { headers: { cookie } });
    expect(overview.status).toBe(200);
    expect(await overview.text()).toContain("Hero");

    const editor = await fetch(`${landing}/regions/home.hero`, { headers: { cookie } });
    expect(editor.status).toBe(200);
    expect(await editor.text()).toContain('name="f[heading]"');

    // The stylesheet and the client bundles come from the package's own public folder.
    const css = await fetch(`http://127.0.0.1:${port}/assets/studio.css`, { redirect: "manual" });
    expect(css.status).toBeLessThan(400);

    expect((await fetch(link as string, { redirect: "manual" })).status).toBe(403);
    expect((await fetch(landing, { redirect: "manual" })).status).toBe(303);

    // Publishing is a plain form post, and one commit in this working copy as the developer.
    const before = site.head();
    const saved = await fetch(`${landing}/regions/home.hero`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: `http://127.0.0.1:${port}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        headSha: before,
        action: "publish",
        "f[heading]": "From the command",
      }).toString(),
    });
    expect(saved.status).toBeLessThan(400);
    expect(site.head()).not.toBe(before);
    expect(site.read("content/cms/home.hero.json")).toContain("From the command");
    const author = execFileSync("git", ["log", "-1", "--format=%ae"], {
      cwd: site.root,
      encoding: "utf8",
    });
    expect(author.trim()).toBe("test@example.com");

    child?.kill("SIGINT");
    expect(await run.exit).toBe(0);
    expect(run.output()).toContain("Stopped.");
    await expect(fetch(landing)).rejects.toThrow();

    // State went to node_modules/.cache, which the site ignores: nothing new for `git status`.
    expect(existsSync(join(site.root, "node_modules/.cache/greatcms/studio.sqlite"))).toBe(true);
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: site.root,
      encoding: "utf8",
    });
    expect(status).toBe("");
  }, 40_000);

  it("says what to do in a folder that is not a site", async () => {
    const { rmSync } = await import("node:fs");
    rmSync(join(site.root, ".cms/schema.yaml"));
    const run = start(["--no-open"]);
    expect(await run.exit).toBe(1);
    expect(run.output()).toContain("greatcms init");
  });
});
