import { describe, expect, it } from "vitest";
import { parseSchema } from "./schema.js";
import { validateFields, validateRegion } from "./validate.js";

const schema = parseSchema(`
version: 1
blocks:
  hero:
    fields:
      heading: { type: text, required: true, max: 10 }
  text:
    fields:
      body: { type: richtext }
regions:
  home.hero:
    fields:
      heading: { type: text, required: true, max: 10 }
      count: { type: number, integer: true, min: 1 }
      tone: { type: select, options: [calm, loud] }
      image: { type: image }
      decor: { type: image, alt: decorative-allowed }
      when: { type: date }
      cta: { type: link }
      tags: { type: list, of: { type: text }, max: 2 }
      seo:
        type: group
        fields:
          title: { type: text, required: true }
  home.body:
    type: blocks
    allow: [hero, text]
    max: 2
`);

const fields = (schema.regions["home.hero"] as { fields: never }).fields;

describe("validateFields", () => {
  it("accepts a valid document", () => {
    const result = validateFields(fields, {
      heading: "Hi",
      count: 3,
      tone: "calm",
      image: { src: "/m/a.webp", alt: "A cat" },
      decor: { src: "/m/b.webp", alt: "" },
      when: "2026-08-12",
      cta: { href: "/about" },
      tags: ["a"],
      seo: { title: "Home" },
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    " javascript:x",
    "data:text/html,<script>x</script>",
    "vbscript:x",
  ])("refuses a link or image address that could run script: %j", (href) => {
    const result = validateFields(fields, {
      heading: "Hi",
      seo: { title: "x" },
      cta: { href },
      image: { src: href, alt: "A cat" },
    });
    expect(result.issues.map((i) => `${i.path}:${i.code}`)).toEqual([
      "image.src:unsafe_url",
      "cta.href:unsafe_url",
    ]);
  });

  it.each([
    "/about",
    "#top",
    "about",
    "https://example.com",
    "mailto:a@b.c",
    "tel:+250788",
    "?q=1",
  ])("accepts an ordinary address: %j", (href) => {
    const result = validateFields(fields, { heading: "Hi", seo: { title: "x" }, cta: { href } });
    expect(result.ok).toBe(true);
  });

  it("reports a missing required field", () => {
    const result = validateFields(fields, { seo: { title: "x" } });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => `${i.path}:${i.code}`)).toContain("heading:required");
  });

  it("enforces max length", () => {
    const result = validateFields(fields, { heading: "x".repeat(11), seo: { title: "x" } });
    expect(result.issues.map((i) => i.code)).toContain("too_long");
  });

  it("rejects an image with no alt text and explains why", () => {
    const result = validateFields(fields, {
      heading: "Hi",
      seo: { title: "x" },
      image: { src: "/m/a.webp" },
    });
    const issue = result.issues.find((i) => i.code === "missing_alt");
    expect(issue?.path).toBe("image.alt");
    expect(issue?.fix).toContain("screen readers");
  });

  it("rejects empty alt on a required-alt field but allows it on a decorative field", () => {
    const bad = validateFields(fields, {
      heading: "Hi",
      seo: { title: "x" },
      image: { src: "/m/a.webp", alt: "" },
    });
    expect(bad.issues.map((i) => i.code)).toContain("empty_alt");

    const good = validateFields(fields, {
      heading: "Hi",
      seo: { title: "x" },
      decor: { src: "/m/b.webp", alt: "" },
    });
    expect(good.ok).toBe(true);
  });

  it("validates nested groups and lists with a path", () => {
    const result = validateFields(fields, {
      heading: "Hi",
      seo: {},
      tags: ["a", "b", "c"],
    });
    const codes = result.issues.map((i) => `${i.path}:${i.code}`);
    expect(codes).toContain("seo.title:required");
    expect(codes).toContain("tags:too_many");
  });

  it("rejects values outside a select", () => {
    const result = validateFields(fields, { heading: "Hi", seo: { title: "x" }, tone: "shouty" });
    const issue = result.issues.find((i) => i.code === "not_an_option");
    expect(issue?.fix).toContain("calm, loud");
  });

  it("ignores unknown keys by default and reports them in strict mode", () => {
    const doc = { heading: "Hi", seo: { title: "x" }, leftover: "old value" };
    expect(validateFields(fields, doc).ok).toBe(true);
    const strict = validateFields(fields, doc, { strict: true });
    expect(strict.issues.map((i) => i.code)).toContain("unknown_field");
  });

  it("never treats machinery keys as unknown", () => {
    const doc = { heading: "Hi", seo: { title: "x" }, _meta: { updatedAt: "now" } };
    expect(validateFields(fields, doc, { strict: true }).ok).toBe(true);
  });
});

describe("validateRegion", () => {
  it("validates blocks and their allowed types", () => {
    const ok = validateRegion(schema, "home.body", {
      blocks: [{ _type: "hero", heading: "Hi" }],
    });
    expect(ok.ok).toBe(true);

    const bad = validateRegion(schema, "home.body", {
      blocks: [{ _type: "nope" }, { heading: "x" }],
    });
    const codes = bad.issues.map((i) => i.code);
    expect(codes).toContain("block_not_allowed");
    expect(codes).toContain("missing_block_type");
  });

  it("enforces block count limits", () => {
    const result = validateRegion(schema, "home.body", {
      blocks: [
        { _type: "hero", heading: "a" },
        { _type: "hero", heading: "b" },
        { _type: "hero", heading: "c" },
      ],
    });
    expect(result.issues.map((i) => i.code)).toContain("too_many");
  });

  it("reports an unknown region rather than silently passing", () => {
    const result = validateRegion(schema, "nope.missing", {});
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("unknown_region");
  });
});

describe("fields with a condition", () => {
  const hero = parseSchema(
    `version: 1
regions:
  hero:
    fields:
      style: { type: select, options: [text, carousel], default: text }
      heading: { type: text, required: true, when: { field: style, equals: text } }
      slides: { type: list, of: { type: text }, min: 1, when: { field: style, in: [carousel] } }
`,
  ).regions.hero;

  it("asks for a required field only while its condition holds", () => {
    const def = hero.type === "blocks" ? {} : hero.fields;
    expect(validateFields(def, { style: "text" }).ok).toBe(false);
    expect(validateFields(def, { style: "carousel", slides: ["one"] }).ok).toBe(true);
  });

  it("keeps a hidden field's value without checking it", () => {
    const def = hero.type === "blocks" ? {} : hero.fields;
    expect(validateFields(def, { style: "text", heading: "Hi", slides: [] }).ok).toBe(true);
  });

  it("refuses a condition that compares against nothing", () => {
    expect(() =>
      parseSchema(`version: 1
regions:
  r:
    fields:
      a: { type: text, when: { field: b } }
`),
    ).toThrow();
  });
});

describe("block variants", () => {
  const withVariants = parseSchema(`version: 1
blocks:
  cta:
    variants: [{ value: panel, label: Panel }, inline]
    fields:
      label: { type: text }
regions:
  body:
    type: blocks
    allow: [cta]
`);

  it("accepts a declared variant and refuses one the block does not have", () => {
    const ok = validateRegion(withVariants, "body", {
      blocks: [{ _type: "cta", _variant: "inline" }],
    });
    expect(ok.ok).toBe(true);
    const bad = validateRegion(withVariants, "body", {
      blocks: [{ _type: "cta", _variant: "huge" }],
    });
    expect(bad.issues.map((issue) => issue.code)).toEqual(["unknown_variant"]);
  });

  it("does not need one to be named", () => {
    expect(validateRegion(withVariants, "body", { blocks: [{ _type: "cta" }] }).ok).toBe(true);
  });
});
