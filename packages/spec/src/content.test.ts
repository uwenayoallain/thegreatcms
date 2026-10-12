import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "./config.js";
import { parseRegionFile, regionDefaults, resolveRegion, serializeRegion } from "./content.js";
import { parseFrontmatter, serializeFrontmatter } from "./markdown.js";
import { collectionEntryPath, regionFilePath, regionIdFromPath, slugify } from "./paths.js";
import { parseSchema } from "./schema.js";

const schema = parseSchema(`
version: 1
blocks:
  hero:
    fields:
      heading: { type: text }
regions:
  home.hero:
    fields:
      heading: { type: text, default: "Hello" }
      subtitle: { type: text, default: "From the schema" }
      seo:
        type: group
        fields:
          title: { type: text, default: "Home" }
          description: { type: text }
      tags: { type: list, of: { type: text } }
    default:
      heading: "Welcome"
  home.body:
    type: blocks
    allow: [hero]
`);

describe("the hybrid fallback", () => {
  const nested = parseSchema(`
version: 1
blocks:
  card:
    fields:
      title: { type: text }
      tone: { type: select, options: [plain, accent], default: plain }
regions:
  home.seo:
    fields:
      seo:
        type: group
        fields:
          title: { type: text, default: Untitled }
          description: { type: text, default: Described }
    default:
      seo: { title: Home }
  home.cards:
    fields:
      cards: { type: blocks, allow: [card], default: [{ _type: card, title: One }] }
`);

  it("merges a region default into a group field without losing its other defaults", () => {
    expect(resolveRegion(nested, "home.seo", null)).toEqual({
      seo: { title: "Home", description: "Described" },
    });
  });

  it("fills block defaults inside a blocks field when no content file exists", () => {
    expect(resolveRegion(nested, "home.cards", null)).toEqual({
      cards: [{ _type: "card", title: "One", tone: "plain" }],
    });
  });

  it("resolves a missing file and an empty file to the same document", () => {
    expect(resolveRegion(nested, "home.cards", null)).toEqual(
      resolveRegion(nested, "home.cards", {}),
    );
  });

  it("renders schema defaults when no content file exists", () => {
    expect(regionDefaults(schema, "home.hero")).toEqual({
      heading: "Welcome",
      subtitle: "From the schema",
      seo: { title: "Home" },
    });
  });

  it("prefers the region default over the field default", () => {
    expect(regionDefaults(schema, "home.hero")?.heading).toBe("Welcome");
  });

  it("layers stored content over defaults so new schema fields still render", () => {
    const resolved = resolveRegion(schema, "home.hero", { heading: "Edited" });
    expect(resolved).toEqual({
      heading: "Edited",
      subtitle: "From the schema",
      seo: { title: "Home" },
    });
  });

  it("merges nested groups rather than replacing them", () => {
    const resolved = resolveRegion(schema, "home.hero", { seo: { description: "Desc" } });
    expect(resolved?.seo).toEqual({ title: "Home", description: "Desc" });
  });

  it("replaces arrays wholesale, because item-wise merging surprises authors", () => {
    const resolved = resolveRegion(schema, "home.hero", { tags: ["only"] });
    expect(resolved?.tags).toEqual(["only"]);
  });

  it("gives a blocks region an empty list by default", () => {
    expect(regionDefaults(schema, "home.body")).toEqual({ blocks: [] });
  });

  it("returns null for a region the schema does not define", () => {
    expect(resolveRegion(schema, "nope.gone", null)).toBeNull();
  });
});

describe("serializeRegion", () => {
  it("sorts keys, puts machinery last, and ends with a newline", () => {
    const out = serializeRegion({ zebra: 1, alpha: 2 }, { updatedAt: "2026-08-12T00:00:00Z" });
    expect(out).toBe(
      '{\n  "alpha": 2,\n  "zebra": 1,\n  "_meta": {\n    "updatedAt": "2026-08-12T00:00:00Z"\n  }\n}\n',
    );
  });

  it("sorts nested objects and blocks the same way, so any two tools agree byte for byte", () => {
    const out = serializeRegion({
      slides: [
        {
          _type: "slide",
          heading: "Hi",
          buttons: [{ style: "solid", _type: "button", link: { label: "Go", href: "/" } }],
        },
      ],
    });
    expect(JSON.parse(out)).toEqual({
      slides: [
        {
          _type: "slide",
          heading: "Hi",
          buttons: [{ _type: "button", link: { href: "/", label: "Go" }, style: "solid" }],
        },
      ],
    });
    expect(out.indexOf('"buttons"')).toBeLessThan(out.indexOf('"heading"'));
    expect(out.indexOf('"href"')).toBeLessThan(out.indexOf('"label"'));
    expect(out.indexOf('"style"')).toBeLessThan(out.indexOf('"_type": "button"'));
    expect(out.indexOf('"heading"')).toBeLessThan(out.indexOf('"_type": "slide"'));
  });

  it("orders keys by code point, not by the locale of the machine writing them", () => {
    expect(Object.keys(JSON.parse(serializeRegion({ b: 1, B: 2, a: 3, Á: 4 })))).toEqual([
      "B",
      "a",
      "b",
      "Á",
    ]);
  });

  it("round-trips through parseRegionFile", () => {
    const doc = { heading: "Hi", tags: ["a", "b"] };
    expect(parseRegionFile(serializeRegion(doc), "x.json")).toMatchObject(doc);
  });

  it("names the file when content is unreadable", () => {
    expect(() => parseRegionFile("{oops", "content/cms/home.hero.json")).toThrow(
      /content\/cms\/home\.hero\.json/,
    );
  });
});

describe("paths", () => {
  it("maps a region id to a file and back", () => {
    const path = regionFilePath(DEFAULT_CONFIG, "home.hero");
    expect(path).toBe("content/cms/home.hero.json");
    expect(regionIdFromPath(DEFAULT_CONFIG, path)).toBe("home.hero");
  });

  it("ignores files outside the regions directory", () => {
    expect(regionIdFromPath(DEFAULT_CONFIG, "src/pages/index.astro")).toBeNull();
  });

  it("refuses region ids that could escape the content directory", () => {
    expect(() => regionFilePath(DEFAULT_CONFIG, "../../etc/passwd")).toThrow(/Invalid region id/);
  });

  it("builds collection entry paths by format", () => {
    expect(
      collectionEntryPath(DEFAULT_CONFIG, { path: "content/blog", format: "markdown" }, "hi"),
    ).toBe("content/blog/hi.md");
    expect(
      collectionEntryPath(DEFAULT_CONFIG, { path: "content/data", format: "json" }, "hi"),
    ).toBe("content/data/hi.json");
  });

  it("slugifies titles into safe file names", () => {
    expect(slugify("Héllo, World! ")).toBe("hello-world");
    expect(slugify("///")).toBe("untitled");
  });
});

describe("markdown collections", () => {
  it("round-trips frontmatter and body", () => {
    const source = serializeFrontmatter({ title: "Post", tags: ["a"] }, "# Hi\n\nBody.");
    const parsed = parseFrontmatter(source);
    expect(parsed.data).toEqual({ title: "Post", tags: ["a"] });
    expect(parsed.body.trim()).toBe("# Hi\n\nBody.");
  });

  it("treats a file with no frontmatter as all body", () => {
    expect(parseFrontmatter("Just text").data).toEqual({});
  });

  it("drops undefined values instead of emitting `null`", () => {
    expect(serializeFrontmatter({ title: "A", draft: undefined }, "x")).not.toContain("draft");
  });
});

describe("a config section with only comments", () => {
  it("is treated as absent, not as an error", () => {
    // What `greatcms init` writes when preview is left unconfigured.
    const config = parseConfig(`version: 1
content:
  regions: content/cms
preview:
  # urlTemplate: "https://{branch}--site.pages.dev"
`);
    expect(config.preview).toBeUndefined();
    expect(config.publish.branch).toBe("main");
    expect(config.content.regions).toBe("content/cms");
  });

  it("parses the config SPEC.md documents as the defaults", () => {
    const spec = readFileSync(new URL("../../../SPEC.md", import.meta.url), "utf8");
    const block = /## 7\.[\s\S]*?```yaml\n([\s\S]*?)```/.exec(spec)?.[1];
    expect(block).toBeTruthy();

    const config = parseConfig(block as string);
    expect(config.publish.dispatchEvent ?? undefined).toBeUndefined();
    expect(config.content.regions).toBe("content/cms");
  });

  it("still applies defaults when whole sections are omitted", () => {
    const config = parseConfig("version: 1\n");
    expect(config.content.media).toBe("public/media");
    expect(config.publish.draftBranchPrefix).toBe("cms/draft");
  });
});

describe("frontmatter fences", () => {
  it.each([
    ["empty frontmatter", "---\n---\nBody\n", {}, "Body\n"],
    ["Windows line endings", "---\r\ntitle: Hi\r\n---\r\nBody\r\n", { title: "Hi" }, "Body\r\n"],
    ["a byte-order mark", "\uFEFF---\ntitle: Hi\n---\nBody\n", { title: "Hi" }, "Body\n"],
    ["no closing fence", "---\ntitle: Hi\n", {}, "---\ntitle: Hi\n"],
    [
      "a first line that only starts with ---",
      "---junk\ntitle: Hi\n---\nBody\n",
      {},
      "---junk\ntitle: Hi\n---\nBody\n",
    ],
  ])("handles %s", (_name, source, data, body) => {
    expect(parseFrontmatter(source)).toEqual({ data, body });
  });

  it("does not end the frontmatter at a line that merely contains ---", () => {
    expect(parseFrontmatter("---\ntitle: a --- b\n---\nBody\n").data).toEqual({
      title: "a --- b",
    });
  });
});

describe("block variants resolve", () => {
  const variants = parseSchema(`version: 1
blocks:
  cta:
    variants: [panel, inline]
    fields:
      label: { type: text, default: Go }
regions:
  body:
    type: blocks
    allow: [cta]
`);

  it("to the first variant unless the content names another it declares", () => {
    const blocks = resolveRegion(variants, "body", {
      blocks: [
        { _type: "cta" },
        { _type: "cta", _variant: "inline" },
        { _type: "cta", _variant: "nope" },
      ],
    })?.blocks as Array<Record<string, unknown>>;
    expect(blocks.map((block) => block._variant)).toEqual(["panel", "inline", "panel"]);
  });
});
