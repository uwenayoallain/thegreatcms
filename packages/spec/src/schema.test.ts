import { describe, expect, it } from "vitest";
import { SpecError } from "./errors.js";
import { isBlocksRegion, parseSchema } from "./schema.js";

const VALID = `
version: 1
blocks:
  hero:
    label: Hero
    fields:
      heading: { type: text, required: true, max: 80 }
      image: { type: image }
  text:
    fields:
      body: { type: richtext }
regions:
  home.hero:
    fields:
      heading: { type: text, required: true, max: 80 }
      cta: { type: link }
    default:
      heading: Welcome
  home.body:
    type: blocks
    allow: [hero, text]
    max: 12
collections:
  blog:
    path: content/blog
    format: markdown
    body: content
    fields:
      title: { type: text, required: true }
      content: { type: richtext }
`;

describe("parseSchema", () => {
  it("parses regions, blocks, and collections", () => {
    const schema = parseSchema(VALID);
    expect(schema.version).toBe(1);
    expect(Object.keys(schema.regions)).toEqual(["home.hero", "home.body"]);
    expect(Object.keys(schema.blocks)).toEqual(["hero", "text"]);
    expect(schema.collections.blog?.path).toBe("content/blog");
  });

  it("distinguishes blocks regions from single regions", () => {
    const schema = parseSchema(VALID);
    expect(isBlocksRegion(schema.regions["home.body"]!)).toBe(true);
    expect(isBlocksRegion(schema.regions["home.hero"]!)).toBe(false);
  });

  it("defaults image alt policy to required", () => {
    const schema = parseSchema(VALID);
    const image = schema.blocks.hero?.fields.image;
    expect(image).toMatchObject({ type: "image", alt: "required" });
  });

  it("rejects a region that allows an undefined block, and says how to fix it", () => {
    const source = `
version: 1
regions:
  home.body:
    type: blocks
    allow: [ghost]
`;
    try {
      parseSchema(source);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SpecError);
      const issue = (err as SpecError).issues[0]!;
      expect(issue.code).toBe("unknown_block");
      expect(issue.path).toBe("regions.home.body.allow[0]");
      expect(issue.fix).toContain("blocks.ghost");
    }
  });

  it("rejects region ids that are not safe file names", () => {
    const source = `
version: 1
regions:
  "Home Hero":
    fields:
      heading: { type: text }
`;
    const err = catchSpecError(() => parseSchema(source));
    expect(err.issues.map((i) => i.code)).toContain("invalid_region_id");
  });

  it("reports every problem at once rather than one per run", () => {
    const source = `
version: 1
regions:
  "Bad Id":
    fields: {}
  other.thing:
    type: blocks
    allow: [nope]
`;
    const err = catchSpecError(() => parseSchema(source));
    const codes = err.issues.map((i) => i.code);
    expect(codes).toContain("invalid_region_id");
    expect(codes).toContain("empty_region");
    expect(codes).toContain("unknown_block");
  });

  it("rejects an unsupported spec version", () => {
    const err = catchSpecError(() =>
      parseSchema("version: 99\nregions:\n  a.b:\n    fields:\n      x: { type: text }\n"),
    );
    expect(err.issues[0]?.code).toBe("unsupported_version");
  });

  it("rejects a schema that manages nothing", () => {
    const err = catchSpecError(() => parseSchema("version: 1\n"));
    expect(err.issues[0]?.code).toBe("nothing_managed");
  });

  it("rejects invalid YAML with a usable message", () => {
    const err = catchSpecError(() => parseSchema("version: 1\n\tbad: indentation\n"));
    expect(err.issues[0]?.code).toBe("invalid_yaml");
    expect(err.issues[0]?.fix).toContain("tabs");
  });

  it("rejects a collection whose body field does not exist", () => {
    const source = `
version: 1
collections:
  blog:
    path: content/blog
    body: missing
    fields:
      title: { type: text }
`;
    const err = catchSpecError(() => parseSchema(source));
    expect(err.issues[0]?.code).toBe("unknown_body_field");
  });

  it("names the file in errors", () => {
    const err = catchSpecError(() =>
      parseSchema("version: 1\n", { file: "sites/a/.cms/schema.yaml" }),
    );
    expect(err.issues[0]?.file).toBe("sites/a/.cms/schema.yaml");
    expect(err.message).toContain("sites/a/.cms/schema.yaml");
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
