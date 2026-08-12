import { FIXTURES_DIR, runConformance } from "@greatcms/conformance";
import { describe, expect, it } from "vitest";
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
