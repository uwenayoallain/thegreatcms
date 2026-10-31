/** A real repository, a real build command, a real swap: what the server does on every publish. */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Deployer, readStatus } from "./deploy.js";

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

// The "build" copies page.txt into dist/index.html, or fails when told to.
const BUILD = "mkdir -p dist && grep -q FAIL page.txt && exit 1; cp page.txt dist/index.html";

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), "greatcms-deploy-src-"));
  root = mkdtempSync(join(tmpdir(), "greatcms-deploy-"));
  git("init", "-q", "-b", "main");
  commit("first");
});

afterEach(() => {
  rmSync(source, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
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

describe("one publish", () => {
  it("builds the commit in a clean checkout and points `current` at it", async () => {
    const sha = commit("hello");
    const result = await deployer().once();

    expect(result).toMatchObject({ outcome: "deployed", sha });
    expect(live()).toBe("hello");
    expect(readlinkSync(join(root, "current"))).toBe(join(root, "releases", sha));
    // The checkout the build ran in is not the released folder: a build cannot leave junk live.
    expect(readdirSync(join(root, "releases", sha))).toEqual(["index.html"]);
    expect(existsSync(join(root, "work"))).toBe(false);
  });

  it("does nothing when the commit is already live", async () => {
    await deployer().once();
    expect((await deployer().once()).outcome).toBe("unchanged");
  });

  it("keeps the old site live when the build fails, and says why", async () => {
    await deployer().once();
    commit("FAIL please");
    const result = await deployer().once();

    expect(result.outcome).toBe("failed");
    expect(live()).toBe("first");
    expect(readStatus(root)).toMatchObject({
      live: { message: "first" },
      failed: { message: "FAIL please" },
    });
    expect(readStatus(root)?.failed?.log).toMatch(/exit|1/);
  });

  it("builds the next good commit after a bad one", async () => {
    await deployer().once();
    commit("FAIL");
    await deployer().once();
    commit("better");
    await deployer().once();

    expect(live()).toBe("better");
    expect(readStatus(root)?.failed).toBeUndefined();
  });

  it("prunes releases beyond `keep`, never the live one", async () => {
    const d = deployer();
    await d.once();
    commit("two");
    await d.once();
    commit("three");
    await d.once();

    const releases = readdirSync(join(root, "releases"));
    expect(releases).toHaveLength(2);
    expect(releases).toContain(readlinkSync(join(root, "current")).split("/").at(-1));
    expect(live()).toBe("three");
  });

  it("never runs the repository's hooks", async () => {
    writeFileSync(
      join(source, ".git/hooks/post-checkout"),
      `#!/bin/sh\ntouch "${root}/hook-ran"\n`,
      { mode: 0o755 },
    );
    commit("hooky");
    await deployer().once();

    expect(existsSync(join(root, "hook-ran"))).toBe(false);
  });

  it("deploys a specific commit when asked, regardless of the branch tip", async () => {
    const wanted = commit("pinned");
    commit("newer");
    const result = await deployer().once(wanted);

    expect(result).toMatchObject({ outcome: "deployed", sha: wanted });
    expect(live()).toBe("pinned");
  });
});

describe("rolling back", () => {
  it("puts an earlier release back live and holds it until something new is published", async () => {
    const d = deployer({ keep: 5 });
    const first = commit("one");
    await d.once();
    commit("second, regretted");
    await d.once();
    expect(live()).toBe("second, regretted");

    expect(await d.rollback(first)).toBe(true);
    expect(live()).toBe("one");
    // The next check sees the same tip and leaves the rollback alone.
    expect(await d.once()).toMatchObject({ outcome: "unchanged", sha: first });
    expect(live()).toBe("one");
    expect(readStatus(root)?.pinned?.sha).toBe(first);

    commit("third, fixed");
    expect(await d.once()).toMatchObject({ outcome: "deployed" });
    expect(live()).toBe("third, fixed");
    expect(readStatus(root)?.pinned).toBeUndefined();
  });

  it("takes a rollback asked for by a file in the root, and refuses one it has no release for", async () => {
    const d = deployer({ keep: 5 });
    const first = commit("one");
    await d.once();
    commit("second");
    await d.once();

    writeFileSync(join(root, "rollback"), `${first}\n`);
    await d.takeRequest();
    expect(live()).toBe("one");
    expect(existsSync(join(root, "rollback"))).toBe(false);

    expect(await d.rollback("0".repeat(40))).toBe(false);
    expect(d.releases()).toHaveLength(2);
  });
});
