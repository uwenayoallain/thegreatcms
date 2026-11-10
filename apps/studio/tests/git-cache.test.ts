/** Answers from git are kept per commit: never stale once the branch moves, by the studio or anyone. */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("a publish", () => {
  let log: string;
  /** The git commands the studio starts from here on, by name. */
  const watch = () => {
    const bin = mkdtempSync(join(tmpdir(), "greatcms-git-watch-"));
    log = join(bin, "log");
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in -c) skip=1;; *) if [ -n "$skip" ]; then skip=; else echo "$a" >> '${log}'; break; fi;; esac; done\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  };
  const started = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const editor = { name: "Editor", email: "editor@example.com" };
  afterEach(() => vi.unstubAllEnvs());

  it("starts git three times once the folder is known: the check, the staging, the commit", async () => {
    const repo = new LocalRepository(root);
    const publish = async (content: string) =>
      repo.commitFiles({
        message: "content: update a",
        author: editor,
        expectedHeadSha: await repo.getHead(),
        files: [{ path: "a.json", content }],
      });
    await publish('{"round":1}');
    watch();
    const { commitSha } = await publish('{"round":2}');

    expect(started()).toEqual(["diff", "add", "commit"]);
    expect(commitSha).toBe(git("rev-parse", "HEAD"));
    expect(git("show", "HEAD:a.json")).toBe('{"round":2}');
  });

  it("with nothing changed is a success, and makes no commit", async () => {
    const repo = new LocalRepository(root);
    const before = git("rev-parse", "HEAD");
    const { commitSha } = await repo.commitFiles({
      message: "content: update a",
      author: editor,
      files: [{ path: "a.json", content: "{}" }],
    });

    expect(commitSha).toBe(before);
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("is still one commit when one of its files had nothing to stage", async () => {
    const repo = new LocalRepository(root);
    await repo.commitFiles({
      message: "content: update a",
      author: editor,
      files: [
        { path: "a.json", content: '{"changed":true}' },
        { path: "never-there.json", delete: true },
      ],
    });

    expect(git("log", "--format=%s")).toBe("content: update a\nfirst");
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("a.json");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("commits as the editor when the identity git had is gone by the next publish", async () => {
    const config = join(root, "..", `${root.split("/").pop()}.gitconfig`);
    writeFileSync(config, "[user]\n\tname = Machine\n\temail = machine@example.com\n");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    for (const name of ["NAME", "EMAIL"]) {
      vi.stubEnv(`GIT_COMMITTER_${name}`, undefined);
      vi.stubEnv(`GIT_AUTHOR_${name}`, undefined);
    }
    vi.stubEnv("EMAIL", undefined);
    const repo = new LocalRepository(root);
    const publish = (content: string) =>
      repo.commitFiles({
        message: "content: update a",
        author: editor,
        files: [{ path: "a.json", content }],
      });
    await publish('{"round":1}');
    expect(git("log", "-1", "--format=%cn")).toBe("Machine");

    writeFileSync(config, "[user]\n\tuseConfigOnly = true\n");
    await publish('{"round":2}');

    expect(git("log", "-1", "--format=%an|%cn")).toBe("Editor|Editor");
    expect(git("show", "HEAD:a.json")).toBe('{"round":2}');
    rmSync(config);
  });
});
