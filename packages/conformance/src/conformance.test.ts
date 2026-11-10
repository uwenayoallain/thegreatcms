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
    expect(ids).toContain("home.seo"); // region default over a group
    expect(ids).toContain("home.cards"); // defaulted blocks, no content file
    expect(ids).toContain("home.featured"); // references, one never filled in
    expect(ids).toContain("home.merge"); // objects merge, arrays and nulls replace
    expect(ids).toContain("home.mixed"); // blocks the schema does not know
    expect(ids).toContain("home.unset"); // a file with no blocks in it
    expect(ids).toContain("pricing.faq-2.items_list"); // every character an id may hold
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

  it("keeps a reference as the slug stored, and resolves an unfilled multiple one to []", () => {
    expect(readFixtureRegion("home.featured")).toMatchObject({
      post: "publish-from-anywhere",
      guides: [],
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

function everyEntry(): Record<string, unknown> {
  const actual: Record<string, unknown> = {};
  for (const name of Object.keys(fixtureSchema().collections)) {
    for (const entry of readFixtureEntries(name)) actual[`${name}/${entry.slug}`] = entry;
  }
  return actual;
}

const note = (slug: string) => readFixtureEntries("notes").find((e) => e.slug === slug)?.data;

const blogEntry = (slug: string) => readFixtureEntries("blog").find((e) => e.slug === slug);

describe("collections", () => {
  it("reads a Markdown entry as frontmatter plus its body field", () => {
    const entry = blogEntry("publish-from-anywhere");

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
    const entry = blogEntry("publish-from-anywhere");

    // `draft` is in the file; nothing invents fields the file does not have.
    expect(Object.keys(entry?.data ?? {}).toSorted()).toEqual([
      "content",
      "date",
      "draft",
      "related",
      "tags",
      "title",
    ]);
  });

  it("reads frontmatter as YAML 1.2, so `no` and `on` stay words", () => {
    expect(blogEntry("yaml-scalars")?.data.tags).toEqual(["no", "on", "off", "y", "1:30"]);
  });

  it("reads an entry whose frontmatter is empty", () => {
    expect(blogEntry("empty-frontmatter")?.data).toEqual({
      content: "\nAn entry whose frontmatter is empty.\n",
    });
  });

  it("matches the expected entries, which is what a third-party reader is held to", () => {
    const actual = everyEntry();

    expect(verifyEntries(actual)).toMatchObject({ ok: true, checked: 13 });
  });

  it("fails a reader that reformats an MDX body", () => {
    const actual = everyEntry();
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

const merged = () => readFixtureRegion("home.merge") as Record<string, unknown>;

describe("stored content over defaults", () => {
  it("merges a stored object into its default, and replaces an array outright", () => {
    expect(merged().cta).toEqual({ href: "/pricing", label: "Start here" });
    expect(merged().seo).toEqual({
      title: "Stored title",
      description: "A site managed by GreatCMS",
    });
    expect(merged().tags).toEqual([]);
  });

  it("takes null, false and 0 as the values they are, not as nothing stored", () => {
    expect(merged()).toMatchObject({ note: null, shown: false, count: 0 });
  });

  it("leaves a key the schema does not define where it is, whatever it is called", () => {
    expect(merged().legacy).toEqual({ kept: true });
    expect(Object.getOwnPropertyDescriptor(merged(), "__proto__")?.value).toEqual({
      also: "kept",
    });
  });

  it("passes through a block it has no definition for, and corrects a variant it has none for", () => {
    const { blocks } = readFixtureRegion("home.mixed") as { blocks: unknown[] };
    expect(blocks[0]).toMatchObject({ _variant: "panel", style: "primary" });
    expect(blocks[1]).toEqual({ _type: "retired", anything: [1, 2], nested: { left: "alone" } });
    expect(blocks[2]).toEqual({ _type: "card", title: "Null beats a default", tone: null });
    expect(blocks[3]).toBe("not a block at all");
  });

  it("resolves a blocks file with no blocks in it to the region's default", () => {
    expect(readFixtureRegion("home.unset")).toEqual({
      blocks: [{ _type: "card", title: "Default card" }],
    });
  });
});

describe("the verifier and odd keys", () => {
  it("compares a stored __proto__ key instead of losing it on both sides", () => {
    const actual = { ...expectedRegions() };
    const copy = JSON.parse(JSON.stringify(actual["home.merge"])) as Record<string, unknown>;
    delete copy.__proto__;
    actual["home.merge"] = copy;
    expect(verifyRegions(actual).failures.map((failure) => failure.regionId)).toEqual([
      "home.merge",
    ]);
  });
});

describe("entries as they turn up in real repositories", () => {
  it("reads a JSON collection entry as the object in the file", () => {
    expect(readFixtureEntries("people")).toEqual([
      {
        slug: "ann-mukamana",
        data: expect.objectContaining({ name: "Ann Mukamana" }),
      },
    ]);
    expect(readFixtureEntries("people")[0]?.data).not.toHaveProperty("role");
  });

  it("takes only files of the collection's own extension, directly in its folder", () => {
    expect(readFixtureEntries("notes").map((entry) => entry.slug)).toEqual([
      "byte-order-mark",
      "crlf",
      "fence-lookalikes",
      "no-frontmatter",
      "release-1.2",
      "rule-in-body",
      "scalars",
      "unclosed-fence",
    ]);
  });

  it("keeps a body's line endings, and ignores a byte-order mark", () => {
    expect(note("crlf")).toEqual({
      title: "Written on Windows",
      tags: ["a", "b"],
      text: "\r\nFirst line.\r\nSecond line.\r\n",
    });
    expect(note("byte-order-mark")).toEqual({
      title: "Saved with a byte-order mark",
      text: "Body.\n",
    });
  });

  it("needs both fences, each exactly three dashes, for there to be frontmatter", () => {
    expect(Object.keys(note("no-frontmatter") ?? {})).toEqual(["text"]);
    expect(Object.keys(note("unclosed-fence") ?? {})).toEqual(["text"]);
    expect(Object.keys(note("fence-lookalikes") ?? {})).toEqual(["text"]);
    expect(note("rule-in-body")?.text).toContain("\n---\n\ntitle: not frontmatter\n");
  });

  it("reads every scalar as YAML 1.2's core schema does", () => {
    expect(note("scalars")).toMatchObject({
      leading_zero: 7,
      octal: 15,
      hex: 31,
      float: 1.5,
      exponent: 1000,
      version: "1.0",
      date: "2026-08-12",
      yes_is_a_word: "yes",
      explicit: "123",
      empty: null,
      tilde: null,
      folded: "Folded into one line.",
      literal: "Line one.\nLine two.\n",
    });
  });
});
