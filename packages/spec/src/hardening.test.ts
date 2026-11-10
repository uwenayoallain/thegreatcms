import { describe, expect, it } from "vitest";
import {
  SpecError,
  parseConfig,
  parseFrontmatter,
  parseRegionFile,
  parseSchema,
  referencesIn,
  regionFilePath,
  resolveRegion,
  serializeRegion,
  unknownSchemaKeys,
  validateRegion,
  DEFAULT_CONFIG,
} from "./index.js";

const SCHEMA = `version: 1
blocks:
  card:
    variants: [plain, loud]
    fields:
      title: { type: text, required: true, max: 40, pattern: '^[A-Z]' }
      link: { type: link }
      inner: { type: blocks, allow: [card] }
      author: { type: reference, collection: people }
regions:
  home.hero:
    fields:
      heading: { type: text, default: Hello }
      seo: { type: group, fields: { title: { type: text, default: Meta } } }
      tone: { type: select, options: [a, b], default: a }
      photo: { type: image }
      when: { type: date }
      tags: { type: list, of: { type: text }, max: 3 }
    default: { seo: { title: Region } }
  home.body:
    type: blocks
    allow: [card]
collections:
  people:
    path: content/people
    fields:
      name: { type: text }
`;
const schema = parseSchema(SCHEMA);

const nested = (depth: number) => {
  let block: Record<string, unknown> = { _type: "card", title: "Leaf" };
  for (let i = 0; i < depth; i++) block = { _type: "card", title: "Node", inner: [block] };
  return { blocks: [block] };
};

const cardBody = (title: string) => ({ blocks: [{ _type: "card", title }] });

/** The only failure these functions are allowed: one that says what is wrong. */
function typedOrFine(work: () => unknown): void {
  try {
    work();
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(SpecError);
  }
}

describe("keys that mean something to JavaScript and nothing to the standard", () => {
  const stored = JSON.parse(
    '{"heading":"Hi","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"seo":{"__proto__":{"polluted":true}}}',
  ) as Record<string, unknown>;

  it("resolves them as the ordinary stored keys they are", () => {
    const resolved = resolveRegion(schema, "home.hero", stored)!;
    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
    expect(Object.hasOwn(resolved, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(resolved))).toMatchObject({ heading: "Hi", tone: "a" });
    expect(JSON.stringify(resolved)).toContain('"__proto__":{"polluted":true}');
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect((resolved as { polluted?: unknown }).polluted).toBeUndefined();
    expect((resolved.seo as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("writes them back out rather than dropping them", () => {
    expect(serializeRegion(stored)).toContain('"__proto__": {');
    expect(JSON.parse(serializeRegion(stored))).toEqual(JSON.parse(JSON.stringify(stored)));
  });

  it("never reads a field's value off Object.prototype", () => {
    const odd = parseSchema(`version: 1
regions:
  a.b:
    fields:
      constructor: { type: text }
      toString: { type: text, required: true }
      __proto__: { type: text, default: kept }
`);
    const result = validateRegion(odd, "a.b", {});
    expect(result.issues.map((issue) => `${issue.path}:${issue.code}`)).toEqual([
      "toString:required",
    ]);
    const resolved = resolveRegion(odd, "a.b", null)!;
    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(resolved, "__proto__")?.value).toBe("kept");
  });

  it("reports an inherited name as the unknown key it is, in strict mode", () => {
    const result = validateRegion(schema, "home.hero", { constructor: "x" }, { strict: true });
    expect(result.issues.map((issue) => issue.code)).toEqual(["unknown_field"]);
  });

  it("does not take an inherited name for a region, a block or a collection field", () => {
    expect(resolveRegion(schema, "constructor", null)).toBeNull();
    expect(validateRegion(schema, "toString", {}).issues[0]?.code).toBe("unknown_region");
    expect(
      validateRegion(schema, "home.body", { blocks: [{ _type: "constructor" }] }).issues[0]?.code,
    ).toBe("block_not_allowed");
    expect(() =>
      parseSchema(
        "version: 1\ncollections:\n  a:\n    path: c/a\n    body: constructor\n    slug: toString\n    fields:\n      t: { type: text }\n",
      ),
    ).toThrow(/unknown_body_field|is not one of this collection's fields/);
  });
});

describe("documents built to exhaust the reader", () => {
  it("resolves and validates blocks nested as deep as real content goes", () => {
    const document = nested(200);
    expect(validateRegion(schema, "home.body", document).ok).toBe(true);
    let block = (resolveRegion(schema, "home.body", document)!.blocks as unknown[])[0] as {
      _variant: string;
      inner?: unknown[];
    };
    for (let i = 0; i < 200; i++) block = block.inner![0] as typeof block;
    expect(block._variant).toBe("plain");
  });

  it("says so, rather than overflowing the stack, when nesting is absurd", () => {
    const document = nested(200_000);
    typedOrFine(() => resolveRegion(schema, "home.body", document));
    typedOrFine(() => validateRegion(schema, "home.body", document));
    typedOrFine(() => serializeRegion(document));
    typedOrFine(() =>
      referencesIn(
        { body: { type: "blocks", allow: ["card"] } },
        { body: document.blocks },
        schema,
      ),
    );
    expect(() => serializeRegion(document)).toThrow(/nested too deeply/);
  });

  it("names the file when JSON or YAML nests past the parser's depth", () => {
    const json = `${'{"a":'.repeat(100_000)}1${"}".repeat(100_000)}`;
    try {
      const deep = parseRegionFile(json, "content/cms/deep.json");
      typedOrFine(() => serializeRegion(deep));
    } catch (error) {
      expect((error as Error).message).toMatch(/^content\/cms\/deep\.json: could not read/);
    }
    const yaml = `a: ${"[".repeat(20_000)}${"]".repeat(20_000)}`;
    expect(() => parseFrontmatter(`---\n${yaml}\n---\n`, "deep.md")).toThrow(
      /^deep\.md: frontmatter is not valid YAML/,
    );
    typedOrFine(() => parseSchema(`version: 1\nregions: ${yaml}`));
    expect(() => parseSchema(`version: 1\nregions: ${"[".repeat(20_000)}`)).toThrow(SpecError);
    expect(() => parseConfig(`version: 1\ncontent: ${"[".repeat(20_000)}`)).toThrow(SpecError);
  });

  it("refuses YAML that expands aliases without end, in every file that is YAML", () => {
    const bomb = [
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]",
      "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]",
      "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]",
      "e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]",
      "f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]",
      "g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]",
    ].join("\n");
    const started = performance.now();
    expect(() => parseSchema(`version: 1\n${bomb}`)).toThrow(SpecError);
    expect(() => parseConfig(`version: 1\n${bomb}`)).toThrow(SpecError);
    expect(() => parseFrontmatter(`---\n${bomb}\n---\n`)).toThrow(/not valid YAML/);
    expect(unknownSchemaKeys(`version: 1\n${bomb}`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("keeps a megabyte of someone's text out of the error it causes", () => {
    const huge = "x".repeat(1_000_000);
    const messages: string[] = [];
    const collect = (work: () => unknown) => {
      try {
        const result = work() as { issues?: readonly { toString(): string }[] } | undefined;
        for (const issue of result?.issues ?? []) messages.push(issue.toString());
      } catch (error) {
        messages.push((error as Error).message);
      }
    };
    collect(() =>
      parseSchema(`version: 1\nregions:\n  ${huge}:\n    fields: { a: { type: ${huge} } }`),
    );
    collect(() => parseSchema(`version: ${huge}`));
    collect(() =>
      parseSchema(`version: 1\nregions:\n  a.b:\n    type: blocks\n    allow: [${huge}]`),
    );
    collect(() => parseConfig(`version: 1\ncontent: { regions: "../${huge}" }`));
    collect(() => regionFilePath(DEFAULT_CONFIG, huge));
    collect(() => validateRegion(schema, huge, {}));
    collect(() => validateRegion(schema, "home.hero", { tone: huge, [huge]: 1 }, { strict: true }));
    collect(() =>
      validateRegion(schema, "home.body", {
        blocks: [{ _type: huge }, { _type: "card", title: "A", _variant: huge, author: huge }],
      }),
    );
    expect(messages.length).toBeGreaterThanOrEqual(8);
    for (const message of messages) expect(message.length).toBeLessThan(2000);
  });
});

describe("random damage", () => {
  // A fixed seed: a failure here reproduces.
  let seed = 0x5eed1234;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const pick = <T>(items: readonly T[]): T => items[random(items.length)]!;
  const SPLICES = [
    ":",
    " ",
    "\n",
    "  ",
    "- ",
    "[",
    "]",
    "{",
    "}",
    ",",
    "#",
    "&a ",
    "*a",
    "!!js/function ",
    "|",
    ">",
    "'",
    '"',
    "\t",
    "null",
    "~",
    "true",
    "1",
    "-1",
    "1e999",
    "__proto__",
    "constructor",
    "<<: ",
    "? ",
    "type: blocks",
    "type: group",
    "fields:",
    "allow: []",
    "of:",
    "\u0000",
    "\ufeff",
    "version: 2",
    "default: ",
    "when: { field: a }",
    "pattern: '('",
    "options: []",
    "..",
    "/",
  ];

  function damage(source: string): string {
    let text = source;
    for (let i = 0, edits = 1 + random(4); i < edits; i++) {
      const at = random(text.length + 1);
      const kind = random(4);
      if (kind === 0) text = text.slice(0, at) + pick(SPLICES) + text.slice(at);
      else if (kind === 1) text = text.slice(0, at) + text.slice(at + 1 + random(12));
      else if (kind === 2) {
        const lines = text.split("\n");
        const line = random(lines.length);
        lines.splice(random(lines.length), 0, lines[line]!);
        text = lines.join("\n");
      } else text = text.slice(0, at) + pick(SPLICES) + text.slice(at + random(6));
    }
    return text;
  }

  it("a damaged schema or config parses, or fails with a SpecError, and never hangs", () => {
    const started = performance.now();
    let parsed = 0;
    for (let i = 0; i < 400; i++) {
      const source = damage(SCHEMA);
      try {
        parseSchema(source);
        parsed++;
      } catch (error) {
        expect(error, source).toBeInstanceOf(SpecError);
        expect((error as SpecError).issues.length, source).toBeGreaterThan(0);
      }
      expect(Array.isArray(unknownSchemaKeys(source))).toBe(true);
      typedOrFine(() =>
        parseConfig(
          damage(
            "version: 1\ncontent:\n  regions: content/cms\npreview:\n  paths:\n    blog: /blog/{slug}\n",
          ),
        ),
      );
    }
    // Some damage is harmless (a comment, a duplicate of a blank line): both outcomes must occur.
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThan(400);
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it("any JSON at all resolves, validates and serializes without an untyped crash", () => {
    const leaf = () =>
      pick<unknown>([
        null,
        true,
        false,
        0,
        -1,
        1.5,
        1e308,
        "",
        "a",
        "Title",
        "javascript:alert(1)",
        "../x",
        "2026-08-12",
        [],
        {},
        { href: "/a" },
        { src: "/a.png", alt: "" },
        { html: "<p>x</p>" },
        { _type: "card" },
        { _type: "nope" },
        { _type: 3 },
      ]);
    const KEYS = [
      "heading",
      "seo",
      "title",
      "tone",
      "photo",
      "when",
      "tags",
      "blocks",
      "_type",
      "_variant",
      "inner",
      "link",
      "author",
      "__proto__",
      "constructor",
      "extra",
    ];
    const value = (depth: number): unknown => {
      const kind = random(depth > 4 ? 1 : 4);
      if (kind === 0) return leaf();
      if (kind === 1) return Array.from({ length: random(4) }, () => value(depth + 1));
      const entries = Array.from({ length: random(5) }, () => [pick(KEYS), value(depth + 1)]);
      return JSON.parse(
        JSON.stringify(Object.fromEntries(entries)).replace('"extra"', '"__proto__"'),
      );
    };
    for (let i = 0; i < 3000; i++) {
      const document = value(0);
      for (const id of ["home.hero", "home.body"]) {
        const result = validateRegion(schema, id, document, { strict: i % 2 === 0 });
        expect(result.ok).toBe(result.issues.length === 0);
        if (document !== null && typeof document === "object" && !Array.isArray(document)) {
          const resolved = resolveRegion(schema, id, document as Record<string, unknown>);
          expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
          // Resolving what was resolved changes nothing more.
          expect(resolveRegion(schema, id, resolved)).toEqual(resolved);
          expect(parseRegionFile(serializeRegion(resolved!), "x.json")).toEqual(
            JSON.parse(JSON.stringify(resolved)),
          );
        }
      }
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("damaged frontmatter is an entry, or an error that names the file", () => {
    const entry =
      '---\ntitle: "A: title"\ndate: 2026-08-12\ntags: [a, b]\nnested:\n  key: value\n---\n\nBody.\n';
    for (let i = 0; i < 3000; i++) {
      const source = damage(entry);
      try {
        const { data, body } = parseFrontmatter(source, "content/blog/x.md");
        expect(typeof body).toBe("string");
        expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
      } catch (error) {
        expect((error as Error).message, source).toMatch(/^content\/blog\/x\.md: frontmatter/);
      }
    }
  });
});

describe("a schema's own pattern", () => {
  it("is compiled once, and still applied to every value", () => {
    for (let i = 0; i < 50; i++) {
      expect(validateRegion(schema, "home.body", cardBody("Upper")).ok).toBe(true);
      expect(validateRegion(schema, "home.body", cardBody("lower")).issues[0]?.code).toBe(
        "pattern_mismatch",
      );
    }
  });
});
