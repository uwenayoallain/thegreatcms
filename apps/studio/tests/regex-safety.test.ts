/** A schema's `pattern` that backtracks without end answers promptly, however the studio was started. */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, makeSite, post, SITE_ID } from "./site.js";

const STUDIO = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("../../../packages/cli/bin/greatcms.mjs", import.meta.url));

const SCHEMA = `version: 1
regions:
  home.hero:
    fields:
      code: { type: text, pattern: "^(a+)+$" }
`;
/** Long enough that backtracking would outlast the test many times over. */
const HOSTILE = `${"a".repeat(64)}!`;
const PROMPT_MS = 5000;

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
});

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  site.cleanup();
});

/** Starts a process and resolves with what it has printed once `pattern` shows up. */
function run(args: string[], cwd: string, extra: Record<string, string> = {}) {
  let output = "";
  const { STUDIO_PASSWORD: _password, ...env } = process.env;
  const running = spawn(process.execPath, args, {
    cwd,
    env: { ...env, NO_COLOR: "1", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = running;
  running.stdout.on("data", (chunk) => (output += String(chunk)));
  running.stderr.on("data", (chunk) => (output += String(chunk)));
  return async (pattern: RegExp) => {
    for (let waited = 0; waited < 20_000; waited += 25) {
      const match = output.match(pattern);
      if (match) return match;
      if (running.exitCode !== null) break;
      // oxlint-disable-next-line no-await-in-loop -- polling the child's output
      await new Promise((wake) => setTimeout(wake, 25));
    }
    throw new Error(`"${pattern}" never appeared in:\n${output}`);
  };
}

/** Publishes the hostile value over HTTP, giving up long before a hung process would answer. */
async function publish(origin: string, siteId: string, cookie: string) {
  const began = Date.now();
  const answer = await fetch(`${origin}/sites/${siteId}/regions/home.hero`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(PROMPT_MS),
    headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      headSha: site.head(),
      action: "publish",
      "f[code]": HOSTILE,
    }).toString(),
  });
  return { status: answer.status, body: await answer.text(), took: Date.now() - began };
}

describe("a pattern that backtracks without end", () => {
  it("is answered promptly by the studio's own validation", async () => {
    const began = Date.now();
    const answer = await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      headSha: site.head(),
      action: "publish",
      "f[code]": HOSTILE,
    });
    expect(answer.status).toBe(422);
    expect(await answer.text()).toContain("Does not match required pattern");
    expect(Date.now() - began).toBeLessThan(PROMPT_MS);
  });

  it("is answered promptly by a studio started with `greatcms studio`", async () => {
    expect(existsSync(join(STUDIO, "dist/start.js")), "run `pnpm build` first").toBe(true);
    site.store.close();
    site.write("package.json", JSON.stringify({ name: "pattern-site", private: true }));
    site.write(".gitignore", "node_modules\n");
    mkdirSync(join(site.root, "node_modules/@greatcms"), { recursive: true });
    symlinkSync(STUDIO, join(site.root, "node_modules/@greatcms/studio"), "dir");
    site.git(["add", "-A"]);
    site.git(["commit", "-qm", "site"]);
    const port = await freePort();
    const seen = run(
      [CLI, "studio", "--no-open", "--no-dev", "--port", String(port)],
      join(site.root, ".cms"),
    );
    const [link] = await seen(/http:\/\/127\.0\.0\.1:\d+\/local\/sign-in\?token=[\w-]+/);
    const signIn = await fetch(link as string, { redirect: "manual" });
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] as string;

    const answer = await publish(`http://127.0.0.1:${port}`, "pattern-site", cookie);
    expect(answer.status).toBe(422);
    expect(answer.body).toContain("Does not match required pattern");
    expect(answer.took).toBeLessThan(PROMPT_MS);
  }, 40_000);

  it("is answered promptly by a studio started in-process with start()", async () => {
    site.store.close();
    const port = await freePort();
    // Nothing but the package's entry is loaded first, as a host application would have it.
    const script = `
      const { start } = await import(process.env.ENTRY);
      const studio = await start({
        password: "an in-process password",
        databaseFile: process.env.DATABASE,
        port: Number(process.env.PORT),
        hostname: "127.0.0.1",
        sites: [{ id: "inside", name: "Inside", path: process.env.SITE, devUrl: "", probeUrl: "", pushAfterPublish: false, deployRoot: "" }],
      });
      console.log("listening on " + studio.port);
    `;
    const seen = run(["--input-type=module", "-e", script], site.root, {
      ENTRY: pathToFileURL(join(STUDIO, "dist/start.js")).href,
      DATABASE: join(site.root, ".git", "studio.sqlite"),
      PORT: String(port),
      SITE: site.root,
    });
    await seen(/listening on \d+/);
    const origin = `http://127.0.0.1:${port}`;
    const signIn = await fetch(`${origin}/sign-in`, {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "an in-process password" }).toString(),
    });
    expect(signIn.status).toBe(303);
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] as string)
      .find((value) => value.startsWith("greatcms_session=")) as string;

    const answer = await publish(origin, "inside", cookie);
    expect(answer.status).toBe(422);
    expect(answer.body).toContain("Does not match required pattern");
    expect(answer.took).toBeLessThan(PROMPT_MS);
  }, 40_000);
});
