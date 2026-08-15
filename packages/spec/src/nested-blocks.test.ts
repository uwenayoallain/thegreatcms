/** Blocks inside blocks: a managed section that holds composed components. */

import { describe, expect, it } from "vitest";
import { fieldDefaults } from "./content.js";
import { parseSchema } from "./schema.js";
import { resolveRegion } from "./content.js";
import { validateRegion } from "./validate.js";

const SCHEMA = parseSchema(
  `version: 1
blocks:
  card:
    label: Card
    fields:
      title: { type: text, required: true }
      body: { type: text }
  grid:
    label: Card grid
    fields:
      heading: { type: text }
      # The nesting: a block whose field is itself a list of blocks.
      cards: { type: blocks, allow: [card], min: 1, max: 4 }
regions:
  home.body:
    type: blocks
    allow: [grid]
  home.panel:
    fields:
      title: { type: text }
      items: { type: blocks, allow: [card, grid] }
`,
  { file: ".cms/schema.yaml" },
);

const validate = (regionId: string, document: unknown) =>
  validateRegion(SCHEMA, regionId, document, { file: "c.json" });

const codes = (result: { issues: readonly { code: string }[] }) =>
  result.issues.map((issue) => issue.code);

/** One grid block wrapping whatever nested cards a case wants to try. */
const grid = (cards: unknown) => ({ blocks: [{ _type: "grid", heading: "Ours", cards }] });

describe("the schema", () => {
  it("accepts a blocks field, with the types it may hold", () => {
    expect(SCHEMA.blocks.grid?.fields.cards).toMatchObject({
      type: "blocks",
      allow: ["card"],
      min: 1,
      max: 4,
    });
  });

  it("accepts one on an ordinary region, not only inside a block", () => {
    expect(SCHEMA.regions["home.panel"]).toMatchObject({
      fields: { items: { type: "blocks", allow: ["card", "grid"] } },
    });
  });

  it("refuses a blocks field that allows nothing, which could hold nothing", () => {
    expect(() =>
      parseSchema(
        "version: 1\nregions:\n  a.b:\n    fields:\n      x: { type: blocks, allow: [] }\n",
        { file: "s" },
      ),
    ).toThrow();
  });
});

describe("validating what is inside", () => {
  it("accepts a well-formed nest", () => {
    expect(validate("home.body", grid([{ _type: "card", title: "One" }])).ok).toBe(true);
  });

  it("reports a required field missing on a block two levels down", () => {
    const result = validate("home.body", grid([{ _type: "card", body: "no title" }]));

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("required");
    expect(result.issues[0]?.path).toBe("blocks[0].cards[0].title");
  });

  it("refuses a block type the nested field does not allow", () => {
    const result = validate("home.body", grid([{ _type: "grid", cards: [] }]));

    expect(codes(result)).toContain("block_not_allowed");
  });

  it("refuses a nested entry with no type at all", () => {
    expect(codes(validate("home.body", grid([{ title: "orphan" }])))).toContain(
      "missing_block_type",
    );
  });

  it("counts the nested list against its own min and max", () => {
    expect(codes(validate("home.body", grid([])))).toContain("too_few");
    expect(
      codes(
        validate(
          "home.body",
          grid(Array.from({ length: 5 }, (_, i) => ({ _type: "card", title: `${i}` }))),
        ),
      ),
    ).toContain("too_many");
  });

  it("wants a list, not an object", () => {
    expect(codes(validate("home.body", grid({ _type: "card", title: "One" })))).toContain(
      "expected_blocks",
    );
  });

  it("validates a blocks field on a plain region too", () => {
    const result = validate("home.panel", { title: "Panel", items: [{ _type: "card" }] });

    expect(codes(result)).toContain("required");
    expect(result.issues[0]?.path).toBe("items[0].title");
  });
});

describe("defaults", () => {
  it("leaves a nested list out rather than inventing one", () => {
    expect(fieldDefaults(SCHEMA.blocks.grid?.fields ?? {})).toEqual({});
  });

  it("uses a declared default when the schema gives one", () => {
    const schema = parseSchema(
      `version: 1
blocks:
  card:
    fields:
      title: { type: text }
regions:
  a.b:
    fields:
      items:
        type: blocks
        allow: [card]
        default: [{ _type: card, title: Starter }]
`,
      { file: "s" },
    );

    expect(resolveRegion(schema, "a.b", null)).toEqual({
      items: [{ _type: "card", title: "Starter" }],
    });
  });
});
