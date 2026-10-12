/** Generated types are worth having only if tsc agrees with them. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSchema } from "@greatcms/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockTypeName, regionTypeName, renderTypes } from "./types.js";

const SCHEMA = parseSchema(
  `version: 1
blocks:
  card:
    label: Card
    fields:
      title: { type: text, required: true }
      tone: { type: select, options: [plain, accent], default: plain }
  grid:
    fields:
      cards: { type: blocks, allow: [card] }
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true }
      subtitle: { type: text, default: Welcome }
      note: { type: text }
      image: { type: image }
      cta: { type: link }
      body: { type: richtext }
      tags: { type: list, of: { type: text } }
      seo:
        type: group
        fields:
          title: { type: text }
  home.body:
    type: blocks
    allow: [card, grid]
collections:
  blog:
    path: content/blog
    format: markdown
    body: content
    fields:
      title: { type: text, required: true }
      content: { type: richtext }
`,
  { file: ".cms/schema.yaml" },
);

const source = renderTypes(SCHEMA);

describe("what it names things", () => {
  it("names a region after its id, the way a person would", () => {
    expect(regionTypeName("home.hero")).toBe("HomeHeroRegion");
    expect(blockTypeName("card")).toBe("CardBlock");
  });

  it("quotes ids that are not identifiers, so the module augmentation parses", () => {
    expect(source).toContain('"home.hero": HomeHeroRegion;');
  });
});

describe("what it says about a field", () => {
  it("makes a required field required", () => {
    expect(source).toMatch(/heading: string;/);
  });

  it("makes a field with a default required too, because resolution guarantees it", () => {
    expect(source).toMatch(/subtitle: string;/);
    expect(source).not.toMatch(/subtitle\?: string;/);
  });

  it("makes an ordinary optional field optional", () => {
    expect(source).toMatch(/note\?: string;/);
  });

  it("types a Markdown entry's body as the Markdown string the reader hands back", () => {
    const entry = source.slice(source.indexOf("export interface BlogEntry"));
    expect(entry).toMatch(/content: string;/);
    expect(entry).not.toMatch(/content\??: RichText;/);
  });

  it("turns select options into a union, not a string", () => {
    expect(source).toContain('tone: "plain" | "accent";');
  });

  it("discriminates blocks by _type", () => {
    expect(source).toContain('_type: "card";');
  });

  it("types a blocks region as the union it allows, not any block", () => {
    expect(source).toContain("blocks: Array<CardBlock | GridBlock>;");
  });

  it("types a nested blocks field by what it allows", () => {
    expect(source).toContain("cards?: Array<CardBlock>;");
  });
});

/** The only test that really matters: does tsc accept it. */
describe("compiling the result", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "greatcms-types-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const readerDist = join(dirname(fileURLToPath(import.meta.url)), "../../reader/dist/index.d.ts");

  function compile(usage: string): { ok: boolean; output: string } {
    mkdirSync(join(root, "src"), { recursive: true });
    // Point the augmentation at the built reader declarations, which is what a
    // real site's node_modules would resolve to.
    writeFileSync(join(root, "src/cms.d.ts"), renderTypes(SCHEMA, { module: readerDist }));
    writeFileSync(join(root, "src/usage.ts"), usage);
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "esnext",
          target: "es2022",
          moduleResolution: "bundler",
          skipLibCheck: true,
        },
        include: ["src"],
      }),
    );

    try {
      execFileSync("npx", ["tsc", "-p", root], { encoding: "utf8", stdio: "pipe" });
      return { ok: true, output: "" };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }

  const usage = (body: string) =>
    [`import type { CmsReader } from ${JSON.stringify(readerDist)};`, "", body].join("\n");

  it("typechecks a correct read", () => {
    const result = compile(
      usage(
        [
          "declare const cms: CmsReader;",
          'const hero = cms.region("home.hero");',
          "export const heading: string = hero.heading;",
          'export const tone = cms.region("home.body").blocks;',
        ].join("\n"),
      ),
    );

    expect(result.output).toBe("");
    expect(result.ok).toBe(true);
  });

  it("rejects a mistyped region id, which is the whole point", () => {
    const result = compile(
      usage(
        [
          "declare const cms: CmsReader;",
          'export const hero = cms.region("home.heroo").heading;',
        ].join("\n"),
      ),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects reading a field the schema does not define", () => {
    const result = compile(
      usage(
        [
          "declare const cms: CmsReader;",
          'export const x = cms.region("home.hero").subtitel;',
        ].join("\n"),
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/subtitel/);
  });

  it("knows an optional field may be undefined", () => {
    const result = compile(
      usage(
        [
          "declare const cms: CmsReader;",
          'export const note: string = cms.region("home.hero").note;',
        ].join("\n"),
      ),
    );

    expect(result.ok).toBe(false);
  });
}, 60_000);

describe("staying current", () => {
  it("emits what a formatter would emit, so --check does not fight oxfmt", () => {
    // The two divergences that made this false at first: a multi-line union,
    // and quoted keys that are already identifiers.
    expect(source).toContain("export type CmsBlock = CardBlock | GridBlock;");
    expect(source).toContain("blog: BlogEntry;");
    expect(source).not.toContain('"blog": BlogEntry;');
  });

  it("wraps wide block unions the same way as oxfmt", () => {
    const schema = parseSchema(
      `
version: 1
blocks:
  feature-grid: { fields: {} }
  statistics: { fields: {} }
  story: { fields: {} }
  products: { fields: {} }
  faq-list: { fields: {} }
  call-to-action: { fields: {} }
  testimonial: { fields: {} }
regions:
  home.sections:
    type: blocks
    allow: [feature-grid, statistics, story, products, faq-list, call-to-action, testimonial]
`,
      { file: "s" },
    );

    const wide = renderTypes(schema);
    expect(wide).toContain("export type CmsBlock =\n  | CallToActionBlock");
    expect(wide).toContain(
      "  blocks: Array<\n    | FeatureGridBlock\n    | StatisticsBlock\n    | StoryBlock\n    | ProductsBlock\n    | FaqListBlock\n    | CallToActionBlock\n    | TestimonialBlock\n  >;",
    );
  });

  it("is byte-identical run twice, which is what --check compares", () => {
    expect(renderTypes(SCHEMA)).toBe(renderTypes(SCHEMA));
  });

  it("changes when the schema does", () => {
    const renamed = parseSchema(
      "version: 1\nregions:\n  home.hero:\n    fields:\n      headline: { type: text }\n",
      { file: "s" },
    );

    expect(renderTypes(renamed)).not.toBe(source);
    expect(renderTypes(renamed)).toContain("headline?: string;");
  });
});

const schemaOf = (text: string) => parseSchema(text, { file: ".cms/schema.yaml" });

describe("names a schema allows but TypeScript does not", () => {
  it("prefixes a type name that would start with a digit", () => {
    expect(regionTypeName("404")).toBe("_404Region");
    expect(blockTypeName("2-col")).toBe("_2ColBlock");
  });

  it("refuses two names that would become the same type", () => {
    const schema = schemaOf(`version: 1
blocks:
  hero-banner: { fields: { title: { type: text } } }
  hero_banner: { fields: { title: { type: text } } }
regions:
  home.body: { type: blocks, allow: [hero-banner, hero_banner] }
`);
    expect(() => renderTypes(schema)).toThrow(/HeroBannerBlock/);
  });

  it("refuses a block that would shadow the CmsBlock union", () => {
    const schema = schemaOf(`version: 1
blocks:
  cms: { fields: { title: { type: text } } }
regions:
  home.body: { type: blocks, allow: [cms] }
`);
    expect(() => renderTypes(schema)).toThrow(/CmsBlock/);
  });

  it("keeps a label containing a comment terminator inside the comment", () => {
    const schema = schemaOf(`version: 1
regions:
  home.hero:
    label: "Hero */ export const owned = 1; /*"
    fields:
      heading: { type: text, description: "Short */ line" }
`);
    const generated = renderTypes(schema);
    expect(generated).not.toContain("*/ export const owned");
    expect(generated).not.toContain("Short */ line");
  });
});
