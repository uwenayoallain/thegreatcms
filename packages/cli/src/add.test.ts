/** Adding to a schema someone wrote by hand, without spoiling it. */

import { DEFAULT_CONFIG, parseSchema } from "@greatcms/spec";
import { describe, expect, it } from "vitest";
import {
  AddError,
  applyPlan,
  insertIntoSchema,
  labelFor,
  parseFieldSpec,
  renderPlan,
  type AddPlan,
} from "./add.js";

const SCHEMA = `# yaml-language-server: $schema=https://example.com/schema.json
#
# What this site lets the CMS manage.

version: 1

site:
  name: Example

blocks:
  quote:
    label: Pull quote
    fields:
      text: { type: text, required: true }

regions:
  # The hero is managed; the layout around it is not.
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true }

collections:
  blog:
    label: Blog
    path: content/blog
    format: markdown
    body: content
    fields:
      title: { type: text, required: true }
      content: { type: richtext }
`;

const apply = (plan: AddPlan, source = SCHEMA) =>
  applyPlan({ plan, source, file: ".cms/schema.yaml", config: DEFAULT_CONFIG });

const region = (over: Partial<AddPlan> = {}): AddPlan =>
  ({
    kind: "region",
    id: "about.intro",
    label: "About intro",
    fields: [parseFieldSpec("heading:text!"), parseFieldSpec("body:richtext")],
    ...over,
  }) as AddPlan;

describe("reading a field off the command line", () => {
  it("takes a name and a type", () => {
    expect(parseFieldSpec("heading:text")).toEqual({
      name: "heading",
      type: "text",
      required: false,
    });
  });

  it("treats a trailing bang as required, which is how a schema reads it", () => {
    expect(parseFieldSpec("body:richtext!").required).toBe(true);
  });

  it("takes select options in parentheses", () => {
    expect(parseFieldSpec("style:select(primary|secondary)").options).toEqual([
      "primary",
      "secondary",
    ]);
  });

  it("takes the item type of a list", () => {
    expect(parseFieldSpec("tags:list(text)").of).toBe("text");
  });

  it("refuses a select with one option, which is not a choice", () => {
    expect(() => parseFieldSpec("style:select(only)")).toThrow(/at least two options/);
  });

  it("names the types it knows when given one it does not", () => {
    expect(() => parseFieldSpec("heading:paragraph")).toThrow(/richtext/);
  });

  it("refuses a field name that would not survive a round trip", () => {
    expect(() => parseFieldSpec("My Field:text")).toThrow(AddError);
  });

  it("says how to write it when the whole thing is unreadable", () => {
    expect(() => parseFieldSpec("heading")).toThrow(/name:type/);
  });
});

describe("inserting into a schema", () => {
  it("keeps every comment the author wrote", () => {
    const { schema } = apply(region());

    expect(schema).toContain("# What this site lets the CMS manage.");
    expect(schema).toContain("# The hero is managed; the layout around it is not.");
    expect(schema).toContain("$schema=https://example.com/schema.json");
  });

  it("leaves the existing entries exactly as they were", () => {
    const { schema } = apply(region());

    expect(schema).toContain("  home.hero:\n    label: Home hero");
    expect(schema).toContain("      text: { type: text, required: true }");
  });

  it("puts the new region under regions, not at the end of the file", () => {
    const { schema } = apply(region());
    const parsed = parseSchema(schema, { file: ".cms/schema.yaml" });

    expect(Object.keys(parsed.regions)).toEqual(["home.hero", "about.intro"]);
    expect(schema.indexOf("about.intro")).toBeLessThan(schema.indexOf("collections:"));
  });

  it("creates the section when the schema has none of that kind yet", () => {
    const noBlocks = [
      "version: 1",
      "",
      "regions:",
      "  home.hero:",
      "    fields:",
      "      heading: { type: text }",
      "",
    ].join("\n");

    const { schema } = apply(
      { kind: "block", name: "gallery", label: "Gallery", fields: [parseFieldSpec("alt:text!")] },
      noBlocks,
    );

    expect(schema).toContain("blocks:");
    expect(parseSchema(schema, { file: "s" }).blocks.gallery?.label).toBe("Gallery");
  });

  it("parses as a schema afterwards, every time", () => {
    const { schema } = apply(region());
    expect(() => parseSchema(schema, { file: ".cms/schema.yaml" })).not.toThrow();
  });

  it("does not run the two sections together", () => {
    const { schema } = apply(region());
    expect(schema).not.toMatch(/body: \{ type: richtext \}\ncollections:/);
  });
});

describe("what it writes", () => {
  it("gives a required text field a default, so the site is never blank", () => {
    const { schema } = apply(region());
    const parsed = parseSchema(schema, { file: "s" });
    const about = parsed.regions["about.intro"] as { default?: Record<string, unknown> };

    expect(about.default?.heading).toBe("About intro");
  });

  it("writes a blocks region as a list of allowed types", () => {
    const { schema } = apply(
      region({ id: "home.body", label: "Home sections", allow: ["quote"], fields: [] }),
    );

    expect(schema).toContain("type: blocks");
    expect(schema).toContain("allow: [quote]");
  });

  it("marks a collection's title as its slug source, which is what a file name needs", () => {
    const { schema } = apply({
      kind: "collection",
      name: "notes",
      label: "Notes",
      path: "content/notes",
      format: "markdown",
      body: "content",
      fields: [parseFieldSpec("title:text!"), parseFieldSpec("content:richtext")],
    });

    expect(schema).toContain("slug: title");
    expect(parseSchema(schema, { file: "s" }).collections.notes?.slug).toBe("title");
  });

  it("renders a select with its options intact", () => {
    const yaml = renderPlan({
      kind: "block",
      name: "cta",
      label: "Call to action",
      fields: [parseFieldSpec("style:select(primary|secondary)")],
    });

    expect(yaml).toContain("style: { type: select, options: [primary, secondary] }");
  });
});

describe("refusing rather than corrupting", () => {
  it("will not add a region that is already there", () => {
    expect(() => apply(region({ id: "home.hero" }))).toThrow(/already has a region/);
  });

  it("will not add a block that is already there", () => {
    expect(() =>
      apply({ kind: "block", name: "quote", label: "Quote", fields: [parseFieldSpec("t:text")] }),
    ).toThrow(/already has a block/);
  });

  it("refuses a region id the standard would reject", () => {
    expect(() => apply(region({ id: "Home Hero" }))).toThrow(/not a usable region id/);
  });

  it("points at `add block` when a blocks region allows a type nobody defined", () => {
    expect(() => apply(region({ id: "home.body", allow: ["gallery"], fields: [] }))).toThrow(
      /greatcms add block gallery/,
    );
  });
});

describe("where the content will live", () => {
  it("names the file the studio will write for a region", () => {
    expect(apply(region()).contentPath).toBe("content/cms/about.intro.json");
  });

  it("names the directory for a collection", () => {
    const result = apply({
      kind: "collection",
      name: "notes",
      label: "Notes",
      path: "content/notes",
      format: "markdown",
      fields: [parseFieldSpec("title:text!")],
    });

    expect(result.contentPath).toBe("content/notes");
  });
});

describe("labels", () => {
  it("turns an id into the label a person would have typed", () => {
    expect(labelFor("home.hero")).toBe("Home hero");
    expect(labelFor("about-us")).toBe("About us");
  });
});

describe("insertIntoSchema on its own", () => {
  it("appends to a section that ends the file", () => {
    const source = "version: 1\n\nregions:\n  a.b:\n    fields:\n      x: { type: text }\n";
    const result = insertIntoSchema(
      source,
      "regions",
      "  c.d:\n    fields:\n      y: { type: text }\n",
    );

    expect(result).toContain("a.b:");
    expect(result.indexOf("c.d:")).toBeGreaterThan(result.indexOf("a.b:"));
  });

  it("keeps a trailing comment attached to whatever follows it", () => {
    const source = [
      "regions:",
      "  a.b:",
      "    fields:",
      "      x: { type: text }",
      "",
      "# Media",
      "media: x",
      "",
    ].join("\n");
    const result = insertIntoSchema(source, "regions", "  c.d:\n    fields: {}\n");

    expect(result.indexOf("c.d:")).toBeLessThan(result.indexOf("# Media"));
  });
});

describe("nested blocks, the composed-component case", () => {
  it("takes the block types a field may hold", () => {
    expect(parseFieldSpec("cards:blocks(card|quote)").allow).toEqual(["card", "quote"]);
  });

  it("insists a blocks field can hold something", () => {
    expect(() => parseFieldSpec("cards:blocks()")).toThrow(/at least one block type/);
  });

  it("writes the allow list into the schema", () => {
    const yaml = renderPlan({
      kind: "block",
      name: "grid",
      label: "Card grid",
      fields: [parseFieldSpec("cards:blocks(quote)")],
    });

    expect(yaml).toContain("cards: { type: blocks, allow: [quote] }");
  });

  it("refuses to nest a block type nobody has defined", () => {
    expect(() =>
      apply({
        kind: "block",
        name: "grid",
        label: "Card grid",
        fields: [parseFieldSpec("cards:blocks(card)")],
      }),
    ).toThrow(/greatcms add block card/);
  });

  it("accepts one that does exist, and stays parseable", () => {
    const { schema } = apply({
      kind: "block",
      name: "grid",
      label: "Card grid",
      fields: [parseFieldSpec("cards:blocks(quote)")],
    });

    expect(parseSchema(schema, { file: "s" }).blocks.grid?.fields.cards).toMatchObject({
      type: "blocks",
      allow: ["quote"],
    });
  });
});
