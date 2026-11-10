import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES_DIR } from "@greatcms/conformance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReader } from "./index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greatcms-shared-"));
  cpSync(FIXTURES_DIR, root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const hero = () => join(root, "content/cms/home.hero.json");
const longAgo = (file: string) => utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));

describe("a reader per page, which is what the scaffolded code does", () => {
  it("parses the schema once however many readers a build creates", () => {
    expect(createReader({ root }).schema).toBe(createReader({ root }).schema);
  });

  it("parses each entry once across readers", () => {
    const first = createReader({ root }).collection("blog");
    const second = createReader({ root }).collection("blog");
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
  });

  it("gives a new reader the file as it is now, not as an earlier reader saw it", () => {
    expect(createReader({ root }).region("home.hero")).not.toMatchObject({ heading: "Rewritten" });
    writeFileSync(hero(), JSON.stringify({ heading: "Rewritten" }));
    expect(createReader({ root }).region("home.hero")).toMatchObject({ heading: "Rewritten" });
  });

  it("sees an entry added or removed between readers", () => {
    const before = createReader({ root }).collection("blog").length;
    writeFileSync(join(root, "content/blog/added.md"), "---\ntitle: Added\n---\n");
    expect(createReader({ root }).collection("blog")).toHaveLength(before + 1);
    rmSync(join(root, "content/blog/added.md"));
    expect(createReader({ root }).collection("blog")).toHaveLength(before);
  });

  it("re-reads a changed schema", () => {
    const schema = join(root, ".cms/schema.yaml");
    expect(createReader({ root }).regionIds()).not.toEqual(["only.one"]);
    writeFileSync(
      schema,
      "version: 1\nregions:\n  only.one:\n    fields:\n      a: { type: text }\n",
    );
    expect(createReader({ root }).regionIds()).toEqual(["only.one"]);
  });

  it("does not remember a file that failed to parse", () => {
    writeFileSync(hero(), "{ nope");
    expect(() => createReader({ root }).region("home.hero")).toThrow(/home\.hero\.json/);
    expect(() => createReader({ root }).region("home.hero")).toThrow(/home\.hero\.json/);
  });
});

describe("in development", () => {
  it("re-reads a file written a moment ago even when its size and time have not moved", () => {
    const dev = createReader({ root, drafts: true });
    writeFileSync(hero(), JSON.stringify({ heading: "AAAA" }));
    const stamp = new Date();
    utimesSync(hero(), stamp, stamp);
    expect(dev.region("home.hero")).toMatchObject({ heading: "AAAA" });

    writeFileSync(hero(), JSON.stringify({ heading: "BBBB" }));
    utimesSync(hero(), stamp, stamp);
    expect(dev.region("home.hero")).toMatchObject({ heading: "BBBB" });
  });

  it("keeps the parse of a file that has sat unchanged", () => {
    for (const slug of ["publish-from-anywhere", "yaml-scalars", "empty-frontmatter"])
      longAgo(join(root, "content/blog", `${slug}.md`));
    const dev = createReader({ root, drafts: true });
    expect(dev.collection("blog")[0]).toBe(dev.collection("blog")[0]);
  });
});

describe("size limits", () => {
  it("refuses a content file too large to be content, naming it and the limit", () => {
    truncateSync(hero(), 33 * 1024 * 1024);
    expect(() => createReader({ root }).region("home.hero")).toThrow(
      /content\/cms\/home\.hero\.json is 33\.0 MB, and the reader takes files up to 32\.0 MB/,
    );
  });

  it("refuses a schema too large to be a schema", () => {
    truncateSync(join(root, ".cms/schema.yaml"), 5 * 1024 * 1024);
    expect(() => createReader({ root })).toThrow(/\.cms\/schema\.yaml is 5\.0 MB/);
  });
});

describe("links", () => {
  it("does not hand one site a file another site's reader was allowed to read", () => {
    // The link stays inside `root`, and leaves the site nested within it.
    const inner = join(root, "inner");
    mkdirSync(join(inner, ".cms"), { recursive: true });
    mkdirSync(join(inner, "content/cms"), { recursive: true });
    writeFileSync(
      join(inner, ".cms/schema.yaml"),
      "version: 1\nregions:\n  home.hero:\n    fields:\n      heading: { type: text, default: Default }\n",
    );
    symlinkSync(hero(), join(inner, "content/cms/home.hero.json"));

    createReader({ root }).region("home.hero");
    expect(createReader({ root: inner }).region("home.hero")).toEqual({ heading: "Default" });
  });

  it("skips a folder standing where a content file should be", () => {
    rmSync(hero());
    mkdirSync(hero());
    expect(createReader({ root }).region("home.hero")).toBeTruthy();
  });
});
