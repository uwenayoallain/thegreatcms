/** The builder against builds that misbehave: links out of the output, strays left running, two builders, a stop mid-build. */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Deployer, healthy, readStatus } from "./deploy.js";

let sandbox: string;
let source: string;
let root: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd: source,
    encoding: "utf8",
  }).trim();

const commit = (text: string) => {
  writeFileSync(join(source, "page.txt"), text);
  git("add", "-A");
  git("commit", "-qm", text);
  return git("rev-parse", "HEAD");
};

const BUILD = "mkdir -p dist && cp page.txt dist/index.html";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "greatcms-builder-hardening-"));
  source = join(sandbox, "source");
  root = join(sandbox, "root");
  mkdirSync(source, { recursive: true });
  mkdirSync(root, { recursive: true });
  git("init", "-q", "-b", "main");
  commit("initial");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const deployer = (overrides: Partial<ConstructorParameters<typeof Deployer>[0]> = {}) =>
  new Deployer({
    source,
    branch: "main",
    root,
    build: BUILD,
    output: "dist",
    keep: 2,
    log: () => {},
    ...overrides,
  });

const live = () => readFileSync(join(root, "current/index.html"), "utf8");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = (check: () => boolean, ms = 5000) =>
  expect.poll(check, { timeout: ms, interval: 50 }).toBe(true);

describe("what a build may put live", () => {
  it("refuses an output that is a link to somewhere else", async () => {
    await deployer().once();
    commit("linked");
    const secret = join(sandbox, "secret");
    mkdirSync(secret);
    writeFileSync(join(secret, "index.html"), "not for visitors");

    const result = await deployer({ build: `ln -s ${secret} dist` }).once();
    expect(result.outcome).toBe("failed");
    expect(live()).toBe("initial");
    expect(readStatus(root)?.failed?.log).toContain("not a folder inside the checkout");
  });

  it("refuses a release holding a link that leaves it, and keeps one that stays inside", async () => {
    await deployer().once();
    const secret = join(sandbox, "secret.txt");
    writeFileSync(secret, "not for visitors");

    for (const link of [`ln -s ${secret} dist/leak`, "ln -s ../../../secret.txt dist/sub/leak"]) {
      commit(`leaky ${link}`);
      // oxlint-disable-next-line no-await-in-loop -- one build at a time in the same root
      const result = await deployer({ build: `${BUILD} && mkdir dist/sub && ${link}` }).once();
      expect(result.outcome).toBe("failed");
      expect(live()).toBe("initial");
      expect(readStatus(root)?.failed?.log).toContain("points outside its output");
    }

    commit("inside");
    const inside = await deployer({
      build: `${BUILD} && mkdir dist/sub && ln -s ../index.html dist/sub/home`,
    }).once();
    expect(inside.outcome).toBe("deployed");
    expect(readFileSync(join(root, "current/sub/home"), "utf8")).toBe("inside");
  });
});

describe("what a build may leave running", () => {
  it("ends everything the build started when it runs out of time", async () => {
    const pidFile = join(sandbox, "pid");
    const result = await deployer({
      build: `sh -c 'echo $$ > ${pidFile}; sleep 600' & wait`,
      timeout: 600,
    }).once();
    expect(result.outcome).toBe("failed");
    const pid = Number(readFileSync(pidFile, "utf8"));
    await until(() => !alive(pid));
    expect(existsSync(join(root, "work"))).toBe(false);
  });

  it("does not wait on, or leave behind, what a finished build left in the background", async () => {
    const pidFile = join(sandbox, "pid");
    const started = Date.now();
    const result = await deployer({
      build: `${BUILD}; (echo $$ > ${pidFile}; exec sleep 600) & sleep 0.2`,
      timeout: 20_000,
    }).once();
    expect(result.outcome).toBe("deployed");
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await until(() => !alive(pid));
  });

  it("stops a build when the builder is stopped, without calling the commit a failure", async () => {
    await deployer().once();
    const sha = commit("slow");
    const pidFile = join(sandbox, "pid");
    const d = deployer({ build: `echo $$ > ${pidFile}; sleep 600` });
    const building = d.once();
    await until(() => existsSync(pidFile));
    d.abort();

    expect((await building).outcome).toBe("failed");
    const status = readStatus(root);
    expect(status?.failed).toBeUndefined();
    expect(status?.live?.sha).not.toBe(sha);
    expect(live()).toBe("initial");
    expect(readdirSync(root).toSorted()).toEqual(["current", "releases", "status.json"]);
    await until(() => !alive(Number(readFileSync(pidFile, "utf8"))));
  });
});

describe("two builders in one root", () => {
  const lock = (held: object) => writeFileSync(join(root, ".lock"), JSON.stringify(held));

  it("leaves the build to the one already at work", async () => {
    await deployer().once();
    commit("contended");
    lock({ pid: 1, host: "another-container", at: Date.now() });

    expect((await deployer().once()).outcome).toBe("busy");
    expect(live()).toBe("initial");
    expect(existsSync(join(root, ".lock"))).toBe(true);
  });

  it("takes over from a builder that died, here or long ago", async () => {
    await deployer().once();
    for (const [text, held] of [
      ["after a crash", { pid: 2 ** 22 - 3, host: hostname(), at: Date.now() }],
      ["after a restart as the same pid", { pid: process.pid, host: hostname(), at: Date.now() }],
      ["after a long silence", { pid: 1, host: "another-container", at: Date.now() - 3_600_000 }],
      ["after nonsense", "not a lock"],
    ] as const) {
      commit(text);
      lock(held);
      // oxlint-disable-next-line no-await-in-loop -- one build at a time in the same root
      expect((await deployer().once()).outcome).toBe("deployed");
      expect(live()).toBe(text);
      expect(existsSync(join(root, ".lock"))).toBe(false);
    }
  });
});

describe("the git in the image", () => {
  it("builds with a git that refuses --end-of-options after --detach, as Debian 12's does", async () => {
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const shims = join(sandbox, "bin");
    mkdirSync(shims);
    writeFileSync(
      join(shims, "git"),
      `#!/bin/sh\ncase " $* " in *" checkout "*" --end-of-options "*) echo "fatal: --detach does not take a path argument" >&2; exit 128;; esac\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${shims}:${path}`;
    try {
      expect((await deployer().once()).outcome).toBe("deployed");
    } finally {
      process.env.PATH = path;
    }
    expect(live()).toBe("initial");
  });
});

describe("the files the builder shares", () => {
  it("keeps status.json whole JSON through failures, with nothing half-written beside it", async () => {
    await deployer().once();
    commit("broken");
    await deployer({ build: "echo no; exit 1" }).once();

    const status = JSON.parse(readFileSync(join(root, "status.json"), "utf8"));
    expect(status.live.message).toBe("initial");
    expect(status.failed.log).toContain("build exited with code 1");
    expect(readdirSync(root).filter((name) => name.includes("tmp"))).toEqual([]);
  });

  it("acts on a rollback request only when it is a small plain file", async () => {
    const first = commit("one");
    const d = deployer({ keep: 5 });
    await d.once();
    commit("two");
    await d.once();
    const request = join(root, "rollback");

    writeFileSync(request, `${first}\n${"x".repeat(100_000)}`);
    await d.takeRequest();
    expect(existsSync(request)).toBe(false);
    expect(live()).toBe("two");

    const elsewhere = join(sandbox, "elsewhere");
    writeFileSync(elsewhere, first);
    symlinkSync(elsewhere, request);
    await d.takeRequest();
    expect(live()).toBe("two");
    expect(existsSync(elsewhere)).toBe(true);
    expect(() => readlinkSync(request)).toThrow();

    mkdirSync(request);
    await d.takeRequest();
    expect(existsSync(request)).toBe(false);

    writeFileSync(request, `${first}\n`);
    await d.takeRequest();
    expect(live()).toBe("one");
  });

  it("reports a watcher healthy while it checks or builds, and not once it has gone quiet", async () => {
    expect(healthy(root, 10_000)).toBe(false);
    await deployer().once();
    expect(healthy(root, 10_000)).toBe(true);

    const status = readStatus(root);
    writeFileSync(
      join(root, "status.json"),
      JSON.stringify({ ...status, checkedAt: new Date(Date.now() - 600_000).toISOString() }),
    );
    expect(healthy(root, 10_000)).toBe(false);
    writeFileSync(join(root, ".lock"), JSON.stringify({ pid: 1, host: "x", at: Date.now() }));
    expect(healthy(root, 10_000)).toBe(true);
  });
});
