/** Hardening regression tests for `greatcms-deploy`. */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Deployer, readStatus } from "./deploy.js";

let sandbox: string;
let source: string;
let root: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd: source,
    encoding: "utf8",
  }).trim();

const commit = (text: string, message = text) => {
  writeFileSync(join(source, "page.txt"), text);
  git("add", "-A");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
};

const BUILD = "mkdir -p dist && grep -q FAIL page.txt && exit 1; cp page.txt dist/index.html";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "greatcms-deploy-hardening-"));
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

describe("property 1: deploy builder isolation and safety", () => {
  it("refuses commit ids or refs that git would read as an option or a range", async () => {
    const first = commit("one");
    const second = commit("two");
    const injectedFile = join(sandbox, "git-option-output");
    const d = deployer();

    const optResult = await d.once(`--output=${injectedFile}`);
    expect(optResult.outcome).toBe("failed");
    expect(existsSync(injectedFile)).toBe(false);

    const detachResult = await d.once("--detach");
    expect(detachResult.outcome).toBe("failed");
    expect(existsSync(join(root, "releases", "--detach"))).toBe(false);

    const rangeResult = await d.once(`${first}..${second}`);
    expect(rangeResult.outcome).toBe("failed");
    expect(readStatus(root)?.live).toBeUndefined();
  });

  it("keeps the work folder and release folders inside the configured root", async () => {
    const outsideTarget = join(sandbox, "escaped-release");
    commit("payload", "seed :/../../../escaped-release");
    const d = deployer();

    const result = await d.once(":/../../../escaped-release");
    expect(result.outcome).toBe("failed");
    expect(existsSync(outsideTarget)).toBe(false);

    if (existsSync(join(root, "current"))) {
      const target = resolve(root, readlinkSync(join(root, "current")));
      expect(relative(root, target).startsWith("..")).toBe(false);
    }
  });

  it("never points `current` at a release whose build failed", async () => {
    const d = deployer();
    commit("FAIL on first build");
    const firstFail = await d.once();
    expect(firstFail.outcome).toBe("failed");
    expect(existsSync(join(root, "current"))).toBe(false);

    const goodSha = commit("good build");
    expect((await d.once()).outcome).toBe("deployed");
    expect(resolve(root, readlinkSync(join(root, "current")))).toBe(
      join(root, "releases", goodSha),
    );
    expect(live()).toBe("good build");

    const badSha = commit("FAIL on second build");
    const secondFail = await d.once();
    expect(secondFail.outcome).toBe("failed");
    expect(resolve(root, readlinkSync(join(root, "current")))).toBe(
      join(root, "releases", goodSha),
    );
    expect(existsSync(join(root, "releases", badSha))).toBe(false);
    expect(live()).toBe("good build");
  });

  it("swaps `current` atomically so a reader never sees a missing or half-written release", async () => {
    const d = deployer();
    await d.once();
    expect(live()).toBe("initial");

    commit("updated");
    const slowDeployer = deployer({
      build:
        "mkdir -p dist && printf 'half' > dist/index.html && sleep 0.1 && printf 'updated' > dist/index.html",
    });

    const seen = new Set<string>();
    let missingOrPartial = false;
    const deploying = slowDeployer.once();
    while (seen.size < 2) {
      try {
        const content = live();
        seen.add(content);
        if (content !== "initial" && content !== "updated") missingOrPartial = true;
      } catch {
        missingOrPartial = true;
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- polling the symlink while the build runs
      await new Promise((r) => setTimeout(r, 5));
    }
    await deploying;

    expect(missingOrPartial).toBe(false);
    expect(live()).toBe("updated");
  });

  it("prunes old releases beyond `keep` without ever touching the live one", async () => {
    const d = deployer({ keep: 2 });
    const first = commit("first");
    await d.once();
    const second = commit("second");
    await d.once();
    const third = commit("third");
    await d.once();

    // Make an older release have a newer mtime than the live one, then deploy `first`.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, "releases", second), future, future);
    utimesSync(join(root, "releases", third), future, future);

    await d.once(first);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, "releases", first), old, old);

    const fourth = commit("fourth");
    await d.once(fourth);

    const kept = readdirSync(join(root, "releases"));
    expect(kept).toHaveLength(2);
    expect(kept).toContain(fourth);
    expect(live()).toBe("fourth");
  });

  it("takes the build command and environment only from operator configuration, never the repository", async () => {
    const repoMarker = join(sandbox, "from-repo");
    mkdirSync(join(source, ".cms"), { recursive: true });
    mkdirSync(join(source, ".git/hooks"), { recursive: true });
    writeFileSync(join(source, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch "${repoMarker}"\n`, {
      mode: 0o755,
    });
    writeFileSync(join(source, ".cms/config.yaml"), `version: 1\nbuild: touch "${repoMarker}"\n`);
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({ scripts: { build: `touch "${repoMarker}"` } }),
    );
    writeFileSync(join(source, ".env"), `DEPLOY_BUILD=touch "${repoMarker}"\n`);
    commit("configured");

    const d = deployer({
      build: 'mkdir -p dist && printf "%s" "$CI" > dist/index.html',
    });
    const result = await d.once();

    expect(result.outcome).toBe("deployed");
    expect(existsSync(repoMarker)).toBe(false);
    expect(live()).toBe("1");
  });
});

describe("property 6: rollback request validation in deployer", () => {
  it("accepts only a release sha that exists in the builder folder and refuses paths or options", async () => {
    const d = deployer({ keep: 5 });
    const first = commit("one");
    await d.once();
    const second = commit("two");
    await d.once();

    for (const bad of [
      "..",
      "../..",
      `../releases/${first}`,
      "--help",
      "-f",
      "--output=/tmp/x",
      "d".repeat(40),
      first.slice(0, 12),
      first.toUpperCase(),
      "",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential verification against the same root
      expect(await d.rollback(bad)).toBe(false);
      writeFileSync(join(root, "rollback"), `${bad}\n`);
      // oxlint-disable-next-line no-await-in-loop -- sequential verification against the same root
      await d.takeRequest();
      expect(resolve(root, readlinkSync(join(root, "current")))).toBe(
        join(root, "releases", second),
      );
    }

    expect(await d.rollback(first)).toBe(true);
    expect(resolve(root, readlinkSync(join(root, "current")))).toBe(join(root, "releases", first));
  });
});
