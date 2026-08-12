import { describe, expect, it } from "vitest";
import {
  expectedRegions,
  fixtureConfig,
  fixtureSchema,
  readFixtureRegion,
  runConformance,
  verifyRegions,
} from "./index.js";

describe("the fixture site", () => {
  it("has a valid schema and config", () => {
    const schema = fixtureSchema();
    expect(Object.keys(schema.regions).length).toBeGreaterThan(0);
    expect(fixtureConfig().content.regions).toBe("content/cms");
  });

  it("covers the cases that break naive implementations", () => {
    const ids = Object.keys(expectedRegions());
    expect(ids).toContain("home.hero"); // fully edited
    expect(ids).toContain("home.notice"); // edited before a field existed
    expect(ids).toContain("about.intro"); // never edited, defaults only
    expect(ids).toContain("home.body"); // block list
    expect(ids).toContain("home.decor"); // decorative image, empty alt
  });
});

describe("the reference reader", () => {
  it("passes its own conformance suite", () => {
    const result = runConformance(readFixtureRegion);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("renders a region that has no content file at all", () => {
    expect(readFixtureRegion("about.intro")).toEqual({
      heading: "About us",
      body: { html: "<p>We have not written this yet.</p>" },
    });
  });

  it("fills in a field added to the schema after the content was written", () => {
    expect(readFixtureRegion("home.notice")).toMatchObject({
      message: "We ship on every commit.",
      badge: "New",
      dismissible: true,
    });
  });

  it("applies block field defaults to stored blocks", () => {
    const body = readFixtureRegion("home.body") as { blocks: Array<Record<string, unknown>> };
    expect(body.blocks.at(-1)).toMatchObject({ _type: "cta", style: "primary" });
  });
});

describe("the verifier", () => {
  it("ignores _meta, which is studio machinery no consumer must reproduce", () => {
    const actual = Object.fromEntries(
      Object.entries(expectedRegions()).map(([id, doc]) => [
        id,
        { ...doc, _meta: { updatedAt: "whenever" } },
      ]),
    );
    expect(verifyRegions(actual).ok).toBe(true);
  });

  it("fails a reader that skips defaults", () => {
    const result = verifyRegions({
      ...expectedRegions(),
      "about.intro": {},
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.regionId).toBe("about.intro");
  });

  it("reports regions that are missing entirely", () => {
    const { "home.hero": _dropped, ...rest } = expectedRegions();
    const result = verifyRegions(rest);
    expect(result.failures.map((f) => `${f.regionId}:${f.reason}`)).toContain(
      "home.hero:missing from output",
    );
  });

  it("reports regions the reader invented", () => {
    const result = verifyRegions({ ...expectedRegions(), "made.up": {} });
    expect(result.failures[0]?.reason).toBe("unexpected region in output");
  });
});
