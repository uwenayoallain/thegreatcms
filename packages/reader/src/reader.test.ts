import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES_DIR, runConformance } from "@greatcms/conformance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReader } from "./index.js";

const reader = createReader({ root: FIXTURES_DIR });

describe("CmsReader", () => {
  it("passes the conformance suite", () => {
    const result = runConformance((id) => reader.region(id));
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("resolves a region with no content file to its defaults", () => {
    expect(reader.region("about.intro")).toMatchObject({ heading: "About us" });
  });

  it("returns blocks ready to map onto components", () => {
    const blocks = reader.blocks("home.body");
    expect(blocks.map((b) => b._type)).toEqual(["hero", "text", "cta", "cta"]);
  });

  it("returns an empty block list for a region that has none", () => {
    expect(reader.blocks("home.hero")).toEqual([]);
  });

  it("fails loudly on a mistyped region id, listing the real ones", () => {
    expect(() => reader.region("home.heroo")).toThrow(/Unknown region "home\.heroo"/);
    expect(() => reader.region("home.heroo")).toThrow(/home\.hero/);
  });

  it("can be told to tolerate unknown regions", () => {
    const lenient = createReader({ root: FIXTURES_DIR, strictRegions: false });
    expect(lenient.region("nope.gone")).toBeNull();
  });

  it("reads a Markdown collection, folding the body into its field", () => {
    const posts = reader.collection("blog");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.slug).toBe("publish-from-anywhere");
    expect(posts[0]?.data.title).toBe("Publish from anywhere");
    expect(String(posts[0]?.data.content)).toContain("Content lives in the repository");
  });

  it("explains itself when a collection does not exist", () => {
    expect(() => reader.collection("news")).toThrow(/Unknown collection "news"/);
  });

  it("explains itself when there is no schema to read", () => {
    expect(() => createReader({ root: "/tmp" })).toThrow(/No \.cms\/schema\.yaml found/);
  });
});

/** Drafts are what the studio writes while someone is still typing, so the site's. */
describe("unsaved drafts", () => {
  let root: string;
  const draft = (path: string, content: string) => {
    const file = join(root, ".cms/draft", path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "greatcms-draft-"));
    cpSync(FIXTURES_DIR, root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prefers a draft over the committed file when they are enabled", () => {
    draft("content/cms/home.hero.json", JSON.stringify({ heading: "Still typing" }));

    expect(createReader({ root, drafts: true }).region("home.hero")).toMatchObject({
      heading: "Still typing",
    });
  });

  it("ignores drafts by default, because that default is what a build gets", () => {
    draft("content/cms/home.hero.json", JSON.stringify({ heading: "Still typing" }));

    expect(createReader({ root }).region("home.hero")).not.toMatchObject({
      heading: "Still typing",
    });
  });

  it("shows a draft for a region that has no committed content at all", () => {
    draft("content/cms/about.intro.json", JSON.stringify({ heading: "Draft about" }));

    expect(createReader({ root, drafts: true }).region("about.intro")).toMatchObject({
      heading: "Draft about",
    });
  });

  it("re-reads on every call, so a running dev server sees the next keystroke", () => {
    const live = createReader({ root, drafts: true });
    expect(live.region<{ heading: string }>("home.hero").heading).not.toBe("Second");

    draft("content/cms/home.hero.json", JSON.stringify({ heading: "Second" }));
    expect(live.region<{ heading: string }>("home.hero").heading).toBe("Second");
  });
});
