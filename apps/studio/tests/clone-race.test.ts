/** Another site's code can write the sites folder; a copy from Git is never made where it can reach. */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Clones, moveInto, sweepStaleClones } from "../src/connect.js";
import { trustFolderGitConfig } from "../src/git-guard.js";

let base: string;
let root: string;
let work: string;
let ranFile: string;
let server: Server | undefined;
let seenInRoot: string[];

const PLANTED = () =>
  `\n[filter "planted"]\n\tsmudge = touch '${ranFile}'; cat\n\trequired = true\n`;

/** Every `.git/config` a sibling site could reach: anything under the sites folder. */
function configsUnder(folder: string, depth = 5): string[] {
  if (depth === 0) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const path = join(folder, entry.name);
    if (entry.name === ".git")
      return existsSync(join(path, "config")) ? [join(path, "config")] : [];
    return configsUnder(path, depth - 1);
  });
}

const git = (args: string[], cwd: string) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });

const otherFilesystem = () => {
  throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
};

/** A repository served as plain files, with a sibling site that plants on every request git makes. */
async function serve(): Promise<string> {
  const source = join(base, "source");
  mkdirSync(source);
  git(["init", "-q", "-b", "main"], source);
  writeFileSync(join(source, ".gitattributes"), "*.md filter=planted\n");
  writeFileSync(join(source, "README.md"), "copied\n");
  git(["add", "."], source);
  git(["commit", "-q", "-m", "first"], source);
  const bare = join(base, "site.git");
  git(["clone", "-q", "--bare", source, bare], base);
  git(["update-server-info"], bare);

  server = createServer((request, response) => {
    seenInRoot.push(...readdirSync(root));
    for (const config of configsUnder(root)) appendFileSync(config, PLANTED());
    const file = normalize(join(base, decodeURIComponent((request.url ?? "").split("?")[0] ?? "")));
    if (!file.startsWith(bare) || !existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/site.git`;
}

beforeEach(() => {
  trustFolderGitConfig(false);
  base = mkdtempSync(join(tmpdir(), "greatcms-clone-race-"));
  root = join(base, "sites");
  work = join(base, "private");
  ranFile = join(base, "ran");
  seenInRoot = [];
  mkdirSync(root);
});
afterEach(() => {
  server?.close();
  server = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe("a copy from Git, with another site planting git config as it runs", () => {
  it("has a fixture that runs, were the copy made inside the sites folder", async () => {
    const url = await serve();
    const clones = new Clones(root, undefined, {}, join(root, "work"));
    await clones.start(url, "site", "");

    expect(existsSync(ranFile)).toBe(true);
  });

  it("is made out of reach, runs nothing, and arrives whole", async () => {
    const url = await serve();
    const clones = new Clones(root, undefined, {}, work);
    await clones.start(url, "site", "");

    expect(clones.list()).toEqual([
      { state: "done", folder: "site", url, path: join(root, "site") },
    ]);
    expect(existsSync(ranFile)).toBe(false);
    expect(seenInRoot).toEqual([]);
    expect(readFileSync(join(root, "site", "README.md"), "utf8")).toBe("copied\n");
    expect(readFileSync(join(root, "site", ".git", "config"), "utf8")).not.toContain("planted");
    expect(readdirSync(work)).toEqual([]);
  });

  it("is refused, and removed, when its config was changed on the way in", async () => {
    const clones = new Clones(
      root,
      async (args) => {
        const target = args.at(-1) as string;
        execFileSync("git", ["init", "-q", target]);
        appendFileSync(join(target, ".git", "config"), PLANTED());
      },
      {},
      work,
    );
    await clones.start("https://example.com/site.git", "site", "");

    const [job] = clones.list();
    expect(job?.state === "failed" && job.reason).toContain("filter.planted.smudge");
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("moving a finished copy into the sites folder", () => {
  it("copies it when the sites folder is on another filesystem, links kept as links", async () => {
    const made = join(work, "site");
    mkdirSync(join(made, ".git"), { recursive: true });
    writeFileSync(join(made, ".git", "HEAD"), "ref: refs/heads/main\n");
    symlinkSync("/etc/hostname", join(made, "link"));

    await moveInto(made, root, "site", otherFilesystem);

    expect(readdirSync(root)).toEqual(["site"]);
    expect(readFileSync(join(root, "site", ".git", "HEAD"), "utf8")).toContain("refs/heads/main");
    expect(readdirSync(join(root, "site"), { withFileTypes: true })[1]?.isSymbolicLink()).toBe(
      true,
    );
  });

  it("leaves nothing half-copied when the name was taken meanwhile", async () => {
    const made = join(work, "site");
    mkdirSync(made, { recursive: true });
    writeFileSync(join(made, "README.md"), "copied\n");
    mkdirSync(join(root, "site"));
    writeFileSync(join(root, "site", "theirs"), "kept\n");

    await expect(moveInto(made, root, "site", otherFilesystem)).rejects.toThrow();

    expect(readdirSync(root)).toEqual(["site"]);
    expect(readdirSync(join(root, "site"))).toEqual(["theirs"]);
  });

  it("clears the studio's own work folder at the next start", () => {
    mkdirSync(join(work, "copy-abc", "site"), { recursive: true });
    mkdirSync(join(root, ".shop.0a1b2c.cloning"));

    expect(sweepStaleClones(root, work)).toEqual([".shop.0a1b2c.cloning"]);
    expect(readdirSync(work)).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });
});
