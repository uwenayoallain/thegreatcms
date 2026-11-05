/** Answers from git are kept per commit: never stale once the branch moves, by the studio or anyone. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRepository, LocalRepositoryError } from "../src/repo.js";

let root: string;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const commitOutside = (file: string, content: string, message: string) => {
  writeFileSync(join(root, file), content);
  git("add", file);
  git("-c", "user.email=t@t", "-c", "user.name=Someone", "commit", "-qm", message);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greatcms-git-cache-"));
  git("init", "-q", "-b", "main");
  commitOutside("a.json", "{}", "first");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the commit HEAD names", () => {
  it("is what git says, read from the .git folder or packed refs", async () => {
    const repo = new LocalRepository(root);
    expect(await repo.getHead()).toBe(git("rev-parse", "HEAD"));
    // The second answer comes from the files: the same commit.
    expect(await repo.getHead()).toBe(git("rev-parse", "HEAD"));
    git("pack-refs", "--all");
    expect(await new LocalRepository(root).getHead()).toBe(git("rev-parse", "HEAD"));
  });

  it("follows a detached HEAD and a commit made in a terminal", async () => {
    const repo = new LocalRepository(root);
    await repo.getHead();
    commitOutside("b.json", "{}", "second");
    expect(await repo.getHead()).toBe(git("rev-parse", "HEAD"));
    git("checkout", "-q", "--detach", "HEAD~1");
    expect(await repo.getHead()).toBe(git("rev-parse", "HEAD"));
  });
});

describe("history", () => {
  it("shows a commit made outside the studio on the very next read", async () => {
    const repo = new LocalRepository(root);
    expect((await repo.history("a.json")).map((entry) => entry.subject)).toEqual(["first"]);
    commitOutside("a.json", '{"changed":true}', "edited in a terminal");
    expect((await repo.history("a.json")).map((entry) => entry.subject)).toEqual([
      "edited in a terminal",
      "first",
    ]);
  });

  it("shows the studio's own publish at once", async () => {
    const repo = new LocalRepository(root);
    await repo.history("a.json");
    await repo.commitFiles({
      message: "content: update a",
      author: { name: "Editor", email: "editor@example.com" },
      files: [{ path: "a.json", content: '{"published":true}' }],
    });
    expect((await repo.history("a.json"))[0]?.subject).toBe("content: update a");
  });
});

describe("a machine with no git identity", () => {
  beforeEach(() => {
    const config = join(root, "..", `${root.split("/").pop()}.gitconfig`);
    // Nothing configured, and no guessing one from the host name: what a fresh CI runner has.
    writeFileSync(config, "[user]\n\tuseConfigOnly = true\n");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    for (const name of ["NAME", "EMAIL"]) {
      vi.stubEnv(`GIT_COMMITTER_${name}`, undefined);
      vi.stubEnv(`GIT_AUTHOR_${name}`, undefined);
    }
    vi.stubEnv("EMAIL", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("still publishes, committed by the editor who made the change", async () => {
    await new LocalRepository(root).commitFiles({
      message: "content: update a",
      author: { name: "Editor", email: "editor@example.com" },
      files: [{ path: "a.json", content: '{"published":true}' }],
    });
    expect(git("log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
      "Editor <editor@example.com>|Editor <editor@example.com>",
    );
  });

  it("says how to give git an identity when there is no editor to commit as", async () => {
    const publish = new LocalRepository(root).commitFiles({
      message: "content: update a",
      files: [{ path: "a.json", content: '{"published":true}' }],
    });
    await expect(publish).rejects.toBeInstanceOf(LocalRepositoryError);
    await expect(publish).rejects.toThrow(/fix: Nothing was committed\. Give git an identity/);
  });
});
