/**
 * Drives the CLI against a real repository on disk — real git, real files, real
 * draft branch. The unit tests cover the logic; this proves the wiring.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "./index.js";

let repo: string;
const out: string[] = [];
const err: string[] = [];

const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function cli(argv: string[]) {
  out.length = 0;
  err.length = 0;
  return run({
    argv,
    cwd: repo,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "greatcms-cli-"));

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);

  mkdirSync(join(repo, ".cms"), { recursive: true });
  mkdirSync(join(repo, "content/cms"), { recursive: true });

  writeFileSync(
    join(repo, ".cms/schema.yaml"),
    `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text, required: true, default: Live heading }
  about.intro:
    fields:
      heading: { type: text, default: About us }
`,
  );
  writeFileSync(join(repo, ".cms/config.yaml"), "version: 1\n");
  writeFileSync(join(repo, "content/cms/home.hero.json"), '{\n  "heading": "Live heading"\n}\n');

  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);

  // A draft branch, exactly as the studio would push one.
  git(["checkout", "-q", "-b", "cms/draft-home.hero"]);
  writeFileSync(join(repo, "content/cms/home.hero.json"), '{\n  "heading": "Draft heading"\n}\n');
  git(["add", "-A"]);
  git(["commit", "-qm", "content(draft): home.hero"]);
  git(["checkout", "-q", "main"]);

  // The repository is its own remote, which is all `ls-remote` and `fetch` need.
  git(["remote", "add", "origin", repo]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("greatcms doctor", () => {
  it("reports which regions have content and which fall back to defaults", async () => {
    expect(await cli(["doctor"])).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/edited\s+home\.hero/);
    expect(text).toMatch(/default\s+about\.intro/);
    expect(text).toContain("will render schema defaults. That is normal, not a problem.");
  });
});

describe("greatcms preview --diff", () => {
  it("finds the draft and shows what it would change, writing nothing", async () => {
    expect(await cli(["preview", "--diff"])).toBe(0);

    const text = out.join("");
    expect(text).toContain("cms/draft-home.hero");
    expect(text).toContain("content/cms/home.hero.json");

    expect(readFileSync(join(repo, "content/cms/home.hero.json"), "utf8")).toContain(
      "Live heading",
    );
  });
});

describe("greatcms preview", () => {
  it("overlays draft content into the working copy", async () => {
    expect(await cli(["preview"])).toBe(0);
    expect(readFileSync(join(repo, "content/cms/home.hero.json"), "utf8")).toContain(
      "Draft heading",
    );
    expect(out.join("")).toContain("Draft content is in place");
  });

  it("restores the working copy when the dev command exits", async () => {
    // Put it back first, then run with a command that exits immediately.
    git(["checkout", "--", "content/cms/home.hero.json"]);

    expect(await cli(["preview", "--run", "true"])).toBe(0);
    expect(readFileSync(join(repo, "content/cms/home.hero.json"), "utf8")).toContain(
      "Live heading",
    );
    expect(out.join("")).toContain("Working copy restored");
  });

  it("refuses to run on top of uncommitted content changes", async () => {
    writeFileSync(join(repo, "content/cms/home.hero.json"), '{"heading":"Half-finished"}');

    expect(await cli(["preview"])).toBe(1);
    expect(err.join("")).toContain("uncommitted changes in your content directories");
    // The half-finished edit is untouched.
    expect(readFileSync(join(repo, "content/cms/home.hero.json"), "utf8")).toContain(
      "Half-finished",
    );

    git(["checkout", "--", "content/cms/home.hero.json"]);
  });

  it("exits with the dev command status so CI can use it", async () => {
    expect(await cli(["preview", "--run", "exit 3"])).toBe(3);
  });
});

describe("unknown input", () => {
  it("prints help rather than a stack trace", async () => {
    expect(await cli(["wat"])).toBe(1);
    expect(err.join("")).toContain("greatcms preview");
  });

  it("does not leave a stray overlay behind after all of that", () => {
    expect(existsSync(join(repo, "content/cms/about.intro.json"))).toBe(false);
  });
});

describe("greatcms init", () => {
  let fresh: string;

  const initIn = (dir: string, argv: string[]) => {
    out.length = 0;
    err.length = 0;
    return run({
      argv,
      cwd: dir,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });
  };

  beforeEach(() => {
    fresh = mkdtempSync(join(tmpdir(), "greatcms-init-"));
  });

  afterEach(() => {
    rmSync(fresh, { recursive: true, force: true });
  });

  it("scaffolds a working setup with no questions asked", async () => {
    writeFileSync(join(fresh, "astro.config.mjs"), "export default {};\n");

    expect(await initIn(fresh, ["init", "--yes"])).toBe(0);

    const schema = readFileSync(join(fresh, ".cms/schema.yaml"), "utf8");
    const config = readFileSync(join(fresh, ".cms/config.yaml"), "utf8");

    expect(schema).toContain("yaml-language-server");
    // Astro was detected, so content lands where Astro already looks.
    expect(config).toContain("regions: src/content/cms");
    expect(out.join("")).toContain("Detected Astro");
  });

  it("tells you how to read the region in the framework it found", async () => {
    writeFileSync(join(fresh, ".eleventy.js"), "module.exports = () => {};\n");

    await initIn(fresh, ["init", "--yes"]);

    const text = out.join("");
    expect(text).toContain("Detected Eleventy");
    expect(text).toContain("global data in Eleventy");
    expect(readFileSync(join(fresh, ".cms/config.yaml"), "utf8")).toContain("regions: _data/cms");
  });

  it("honours explicit flags over detection", async () => {
    writeFileSync(join(fresh, "astro.config.mjs"), "export default {};\n");

    await initIn(fresh, [
      "init",
      "--yes",
      "--framework",
      "eleventy",
      "--template",
      "landing",
      "--name",
      "Flagged Site",
      "--dir",
      "_data/managed",
    ]);

    const schema = readFileSync(join(fresh, ".cms/schema.yaml"), "utf8");
    expect(schema).toContain("Flagged Site");
    expect(schema).toContain("type: blocks");
    expect(readFileSync(join(fresh, ".cms/config.yaml"), "utf8")).toContain(
      "regions: _data/managed",
    );
  });

  it("refuses to clobber an existing setup, and says how to proceed", async () => {
    await initIn(fresh, ["init", "--yes"]);
    const original = readFileSync(join(fresh, ".cms/schema.yaml"), "utf8");

    expect(await initIn(fresh, ["init", "--yes", "--name", "Overwritten"])).toBe(1);
    expect(err.join("")).toContain("already set up");
    expect(err.join("")).toContain("--force");
    expect(readFileSync(join(fresh, ".cms/schema.yaml"), "utf8")).toBe(original);

    expect(await initIn(fresh, ["init", "--yes", "--force", "--name", "Overwritten"])).toBe(0);
    expect(readFileSync(join(fresh, ".cms/schema.yaml"), "utf8")).toContain("Overwritten");
  });

  it("rejects an unknown framework by name, listing the real ones", async () => {
    expect(await initIn(fresh, ["init", "--yes", "--framework", "wordpress"])).toBe(1);
    expect(err.join("")).toContain("astro");
  });

  it("leaves a repository ready for doctor to confirm", async () => {
    writeFileSync(join(fresh, "astro.config.mjs"), "export default {};\n");
    await initIn(fresh, ["init", "--yes", "--template", "blog"]);

    expect(await initIn(fresh, ["doctor"])).toBe(0);
    const text = out.join("");
    expect(text).toContain("home.hero");
    expect(text).toContain("Collections: blog");
  });
});
