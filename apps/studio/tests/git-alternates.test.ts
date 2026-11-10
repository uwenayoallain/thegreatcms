/** A site's own code can write `objects/info/alternates`; the studio's git reads no other repository through it. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIn, trustFolderGitConfig } from "../src/git-guard.js";
import { LocalRepository } from "../src/repo.js";
import { makeSite, post, SITE_ID, type Fixture } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text, required: true }
`;

let site: Fixture;
let outside: string;
let theirs: string;
let alternates: string;

const gitAt = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const publish = (heading: string) =>
  post(site, `/sites/${SITE_ID}/regions/home.hero`, {
    headSha: site.head(),
    action: "publish",
    "f[heading]": heading,
  });

beforeEach(() => {
  trustFolderGitConfig(false);
  site = makeSite({
    schema: SCHEMA,
    files: { "content/cms/home.hero.json": '{"heading":"Before"}\n' },
  });
  outside = mkdtempSync(join(tmpdir(), "greatcms-alternates-"));
  const other = join(outside, "other");
  mkdirSync(other);
  gitAt(other, ["init", "-q", "-b", "main"]);
  writeFileSync(join(other, "secret.txt"), "another site's file\n");
  gitAt(other, ["add", "."]);
  gitAt(other, ["commit", "-q", "-m", "theirs"]);
  theirs = gitAt(other, ["rev-parse", "HEAD"]);
  alternates = join(site.root, ".git/objects/info/alternates");
  mkdirSync(join(site.root, ".git/objects/info"), { recursive: true });
});
afterEach(() => {
  site.cleanup();
  rmSync(outside, { recursive: true, force: true });
});

describe("a repository that takes objects from another one on this machine", () => {
  beforeEach(() => writeFileSync(alternates, `${join(outside, "other/.git/objects")}\n`));

  it("has a fixture plain git would read the other repository through", () => {
    expect(gitAt(site.root, ["show", `${theirs}:secret.txt`])).toBe("another site's file");
  });

  it("is read by no git of the studio's", async () => {
    const repo = new LocalRepository(site.root);

    expect(await repo.fileAt(theirs, "secret.txt")).toBeNull();
    expect(await repo.history("content/cms/home.hero.json")).toEqual([]);
    expect((await gitIn(site.root))?.blocked).toBe(true);
  });

  it("is not published to or pushed from, and its owner is told why and what to do", async () => {
    const before = site.head();
    const answer = await publish("After");
    const said = await answer.text();

    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(said).toContain("takes git objects from outside itself");
    expect(said).toContain("git repack -a -d");
    expect(site.head()).toBe(before);
    expect(gitAt(site.root, ["status", "--porcelain"])).toBe("");
    const pushed = await new LocalRepository(site.root).push();
    expect(pushed.ok === false && pushed.reason).toContain("takes git objects from outside itself");
  });

  it("works again once the file is gone", async () => {
    rmSync(alternates);
    expect((await publish("After")).status).toBe(200);
  });
});

describe("other shapes of that file", () => {
  it("is refused when it is a link", async () => {
    writeFileSync(join(outside, "list"), `${join(outside, "other/.git/objects")}\n`);
    symlinkSync(join(outside, "list"), alternates);

    expect((await gitIn(site.root))?.refusal?.message).toContain("a file the studio will not read");
    expect(await new LocalRepository(site.root).fileAt(theirs, "secret.txt")).toBeNull();
  });

  it("is refused when a store inside the repository passes the reading on", async () => {
    const inner = join(site.root, ".git/objects/inner");
    mkdirSync(join(inner, "info"), { recursive: true });
    writeFileSync(join(inner, "info/alternates"), `${join(outside, "other/.git/objects")}\n`);
    writeFileSync(alternates, "inner\n");

    expect((await gitIn(site.root))?.blocked).toBe(true);
  });

  it("is fine when it names only a store inside the repository, or nothing", async () => {
    mkdirSync(join(site.root, ".git/objects/inner"));
    writeFileSync(alternates, "# a comment\n\ninner\n");

    expect((await gitIn(site.root))?.refusal).toBeNull();
    expect((await publish("After")).status).toBe(200);
  });
});
