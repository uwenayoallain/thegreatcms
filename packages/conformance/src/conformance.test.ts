import { describe, expect, it } from "vitest";
import {
  expectedRegions,
  fixtureConfig,
  fixtureSchema,
  readFixtureRegion,
  runConformance,
  verifyRegions,
  readFixtureEntries,
  verifyEntries,
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

describe("collections", () => {
  it("reads a Markdown entry as frontmatter plus its body field", () => {
    const [entry] = readFixtureEntries("blog");

    expect(entry?.slug).toBe("publish-from-anywhere");
    expect(entry?.data.title).toBe("Publish from anywhere");
    expect(entry?.data.content).toContain("Content lives in the repository");
  });

  it("reads an MDX entry the same way, keeping the JSX untouched", () => {
    const [entry] = readFixtureEntries("guides");

    expect(entry?.slug).toBe("measuring-latency");
    expect(entry?.data.content).toContain(
      '<Chart data={[240, 120, 18]} caption="p99, in milliseconds" />',
    );
  });

  it("keeps a frontmatter date as an ISO string, not a native date", () => {
    // YAML has a timestamp type; the standard does not. A reader that lets its
    // parser resolve one produces a document no other implementation matches.
    const [entry] = readFixtureEntries("guides");

    expect(entry?.data.date).toBe("2026-08-14");
    expect(typeof entry?.data.date).toBe("string");
  });

  it("does not layer schema defaults over an entry that exists", () => {
    const [entry] = readFixtureEntries("blog");

    // `draft` is in the file; nothing invents fields the file does not have.
    expect(Object.keys(entry?.data ?? {}).toSorted()).toEqual([
      "content",
      "date",
      "draft",
      "tags",
      "title",
    ]);
  });

  it("matches the expected entries, which is what a third-party reader is held to", () => {
    const actual: Record<string, unknown> = {};
    for (const name of ["blog", "guides"]) {
      for (const entry of readFixtureEntries(name)) actual[`${name}/${entry.slug}`] = entry;
    }

    expect(verifyEntries(actual)).toMatchObject({ ok: true, checked: 2 });
  });

  it("fails a reader that reformats an MDX body", () => {
    const actual: Record<string, unknown> = {};
    for (const name of ["blog", "guides"]) {
      for (const entry of readFixtureEntries(name)) actual[`${name}/${entry.slug}`] = entry;
    }
    const guide = actual["guides/measuring-latency"] as { data: { content: string } };
    guide.data = { ...guide.data, content: guide.data.content.replace(/<Chart[^>]*\/>/, "<p/>") };

    expect(verifyEntries(actual).ok).toBe(false);
  });
});

describe("nested blocks", () => {
  it("applies a block's own default", () => {
    const showcase = readFixtureRegion("home.showcase") as { blocks: Array<{ heading: string }> };
    expect(showcase.blocks[0]?.heading).toBe("What you get");
  });

  it("applies defaults to blocks nested inside a block", () => {
    const showcase = readFixtureRegion("home.showcase") as {
      blocks: Array<{ cards: Array<{ tone: string }> }>;
    };

    expect(showcase.blocks[0]?.cards.map((card) => card.tone)).toEqual(["plain", "accent"]);
  });
});
