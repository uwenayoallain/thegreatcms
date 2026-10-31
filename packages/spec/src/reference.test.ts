import { describe, expect, it } from "vitest";
import { fieldDefaults, resolveRegion } from "./content.js";
import { SpecError } from "./errors.js";
import { parseSchema } from "./schema.js";
import { referencesIn, validateFields } from "./validate.js";

const schema = parseSchema(`version: 1
blocks:
  quote:
    fields:
      by: { type: reference, collection: people }
  row:
    fields:
      quotes: { type: blocks, allow: [quote] }
collections:
  people:
    path: content/people
    fields:
      name: { type: text, required: true }
  blog:
    path: content/blog
    fields:
      title: { type: text, required: true }
      author: { type: reference, collection: people, required: true }
      related: { type: reference, collection: blog, multiple: true }
regions:
  home.hero:
    fields:
      featured: { type: reference, collection: blog }
      team: { type: reference, collection: people, multiple: true }
      credits:
        type: group
        fields:
          editors: { type: list, of: { type: reference, collection: people } }
      rows: { type: blocks, allow: [row] }
`);

const blog = schema.collections.blog!.fields;
const hero = (schema.regions["home.hero"] as { fields: never }).fields;
const codes = (value: unknown) => validateFields(blog, value).issues.map((issue) => issue.code);

describe("parsing a reference field", () => {
  it("keeps the collection and whether it holds several", () => {
    expect(blog.related).toEqual({ type: "reference", collection: "blog", multiple: true });
    expect(blog.author).toMatchObject({ type: "reference", collection: "people" });
  });

  it("refuses a collection the schema does not define, and names the ones it does", () => {
    const err = catchSpecError(() =>
      parseSchema(`version: 1
collections:
  people:
    path: content/people
    fields:
      name: { type: text }
regions:
  home.hero:
    fields:
      seo:
        type: group
        fields:
          author: { type: reference, collection: authors }
`),
    );
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]).toMatchObject({
      code: "unknown_collection",
      path: "regions.home.hero.fields.seo.fields.author.collection",
    });
    expect(err.issues[0]?.fix).toContain("people");
    expect(err.issues[0]?.fix).toContain("collections.authors");
  });

  it("checks references inside lists and blocks too", () => {
    const err = catchSpecError(() =>
      parseSchema(`version: 1
blocks:
  quote:
    fields:
      by: { type: reference, collection: ghosts }
regions:
  home.hero:
    fields:
      names: { type: list, of: { type: reference, collection: ghosts } }
`),
    );
    expect(err.issues.map((issue) => issue.path)).toEqual([
      "blocks.quote.fields.by.collection",
      "regions.home.hero.fields.names.of.collection",
    ]);
  });

  it("says what is missing when there is no collection", () => {
    const err = catchSpecError(() =>
      parseSchema("version: 1\nregions:\n  a.b:\n    fields:\n      x: { type: reference }\n"),
    );
    expect(err.issues[0]).toMatchObject({
      code: "invalid_schema",
      path: "regions.a.b.fields.x.collection",
    });
    expect(err.issues[0]?.fix).toContain("collection: blog");
  });
});

describe("validating a reference", () => {
  it("accepts a slug, and a list of slugs when multiple", () => {
    expect(codes({ title: "A", author: "ann", related: ["b", "c"] })).toEqual([]);
  });

  it("refuses a value that is not slug-shaped", () => {
    expect(codes({ title: "A", author: "../etc/passwd" })).toEqual(["expected_slug"]);
    expect(codes({ title: "A", author: 3 })).toEqual(["expected_slug"]);
    expect(codes({ title: "A", author: "ann", related: "b" })).toEqual(["expected_array"]);
    const issues = validateFields(blog, { title: "A", author: "ann", related: ["b", ""] }).issues;
    expect(issues.map((issue) => issue.path)).toEqual(["related[1]"]);
    expect(issues[0]?.message).toContain("`blog` entry");
  });

  it("treats a required one as missing when empty", () => {
    expect(codes({ title: "A" })).toEqual(["required"]);
    const required = {
      team: { type: "reference", collection: "p", multiple: true, required: true },
    };
    expect(validateFields(required as never, { team: [] }).issues[0]?.code).toBe("required");
  });
});

describe("resolving a reference", () => {
  it("defaults a multiple reference to an empty list and a single one to nothing", () => {
    expect(fieldDefaults(blog)).toEqual({ related: [] });
    expect(resolveRegion(schema, "home.hero", null)).toEqual({ team: [] });
  });
});

describe("referencesIn", () => {
  it("finds every reference through groups, lists, and nested blocks, with validation's paths", () => {
    const document = {
      featured: "hello-world",
      team: ["ann", "bo"],
      credits: { editors: ["cy"] },
      rows: [{ _type: "row", quotes: [{ _type: "quote", by: "di" }] }],
    };
    expect(referencesIn(hero, document, { blocks: schema.blocks })).toEqual([
      { path: "featured", collection: "blog", slug: "hello-world" },
      { path: "team[0]", collection: "people", slug: "ann" },
      { path: "team[1]", collection: "people", slug: "bo" },
      { path: "credits.editors[0]", collection: "people", slug: "cy" },
      { path: "rows[0].quotes[0].by", collection: "people", slug: "di" },
    ]);
  });

  it("leaves malformed values to validation", () => {
    expect(referencesIn(hero, { featured: "../x", team: "ann" })).toEqual([]);
  });

  it("cannot see into blocks without their definitions", () => {
    const rows = [{ _type: "row", quotes: [{ _type: "quote", by: "di" }] }];
    expect(referencesIn(hero, { rows })).toEqual([]);
  });
});

function catchSpecError(fn: () => unknown): SpecError {
  try {
    fn();
  } catch (err) {
    if (err instanceof SpecError) return err;
    throw err;
  }
  throw new Error("expected a SpecError");
}
