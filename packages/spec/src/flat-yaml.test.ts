import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { NOT_FLAT, parseFlatYaml } from "./flat-yaml.js";

/** What the full parser makes of it, or the fact that it refuses. */
function reference(source: string): unknown {
  try {
    return parseYaml(source, { logLevel: "error" }) ?? {};
  } catch {
    return "(error)";
  }
}

/** Whatever the short path reads, it reads exactly as YAML does; everything else it hands over. */
function agrees(source: string): boolean {
  const flat = parseFlatYaml(source);
  if (flat === NOT_FLAT) return false;
  expect(flat, JSON.stringify(source)).toStrictEqual(reference(source));
  // toStrictEqual treats 0 and -0 alike in some paths; JSON keeps them apart from strings at least.
  expect(JSON.stringify(flat), JSON.stringify(source)).toBe(JSON.stringify(reference(source)));
  return true;
}

describe("the short path for flat frontmatter", () => {
  it("reads the frontmatter entries usually have", () => {
    const source = [
      'title: "Entry number 3: a title"',
      "date: 2026-08-12",
      "updated: 2026-08-12T18:30:00Z",
      "tags: [release, notes, 'two words', \"three\", 4, true, ~]",
      "draft: false",
      "weight: 12",
      "ratio: 0.75",
      "author: ann-mukamana",
      "summary: Don't panic, it's only a title? Yes (really) [sic]",
      "empty:",
      "none: null",
      "",
      "path: /blog/a-post",
    ].join("\n");
    expect(agrees(source)).toBe(true);
    expect(parseFlatYaml(source)).toMatchObject({ date: "2026-08-12", weight: 12, empty: null });
  });

  it("reads nothing at all as an entry with no fields", () => {
    expect(parseFlatYaml("")).toEqual({});
    expect(parseFlatYaml("\n\n")).toEqual({});
  });

  it.each([
    "a: 1\na: 2",
    "a:\n  b: 1",
    "a:\n- 1",
    "a: &x 1\nb: *x",
    "a: !!str 1",
    "a: |\n  text",
    "a: [1, [2]]",
    "a: {b: 1}",
    "a: no # comment",
    "# comment\na: 1",
    "a: b: c",
    "a: 0x1F",
    "a: 0o17",
    "a: 1e3",
    "a: .5",
    "a: -0",
    "a: +1",
    "a: .inf",
    "a: .NaN",
    "a: 0777",
    "a: 12345678901234567890",
    "a: True",
    "a: NULL",
    'a: "tab\\there"',
    "a: 'it''s'",
    'a: "unclosed',
    "a: - b",
    "a: ? b",
    "a: @b",
    "a: `b`",
    "a: %b",
    "a: [a, , b]",
    "a: [a, b,]",
    'a: ["x, y"]',
    "a: [a: b]",
    "__proto__: 1",
    "true: 1",
    "null: 1",
    "1: a",
    "a:b",
    " a: 1",
    "a: 1\r",
    "a: one\ttwo",
    "a: one\u2028two",
    "a: \u00a0padded\u00a0",
    "? a\n: b",
    "- a",
    "...",
    "a: b\n...",
    "<<: {a: 1}",
  ])("agrees with YAML, or hands over, on %j", (source) => {
    agrees(source);
  });

  it("hands the awkward cases to the full parser rather than guess", () => {
    for (const source of [
      "a: 0x1F",
      "a: -0",
      "a: True",
      "a:\n  b: 1",
      "a: 1 # one",
      "__proto__: 1",
      "a: 1\na: 2",
    ])
      expect(parseFlatYaml(source), source).toBe(NOT_FLAT);
  });

  it("keeps a no-break space YAML counts as content", () => {
    const source = "a: \u00a0x\u00a0";
    const flat = parseFlatYaml(source);
    if (flat !== NOT_FLAT) expect(flat).toEqual(parseYaml(source));
  });

  it("matches the YAML parser on ten thousand generated documents", () => {
    // A fixed seed: a failure here reproduces.
    let seed = 0x2f6e2b1;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const pick = <T>(items: readonly T[]): T => items[random(items.length)]!;
    const ATOMS = [
      ..."abcXYZ019 -_.:,;#'\"[]{}!&*?|>%@`~+=/\\()<>$^",
      "true",
      "false",
      "null",
      "~",
      "True",
      "No",
      "yes",
      "on",
      "0",
      "-0",
      "-1",
      "007",
      "1.5",
      "1.",
      ".5",
      "1e3",
      "0x1f",
      "0o7",
      ".inf",
      ".nan",
      "2026-08-12",
      "12:30",
      ": ",
      " #",
      "- ",
      "é",
      "日本",
      "\u00a0",
      "\t",
      "__proto__",
      "<<",
    ];
    const KEYS = ["title", "date", "tags", "a", "b_c", "d-e", "true", "null", "__proto__", "x1"];
    const text = () => Array.from({ length: random(6) }, () => pick(ATOMS)).join("");
    const line = () => {
      const shape = random(10);
      if (shape === 0) return "";
      if (shape === 1) return `${pick(KEYS)}:`;
      if (shape === 2)
        return `${pick(KEYS)}: [${Array.from({ length: random(4) }, text).join(", ")}]`;
      if (shape === 3) return `${pick(KEYS)}: "${text()}"`;
      if (shape === 4) return `${pick(KEYS)}: '${text()}'`;
      if (shape === 5) return `${text()}`;
      return `${pick(KEYS)}:${pick([" ", " ", " ", "  ", ""])}${text()}`;
    };
    let taken = 0;
    for (let i = 0; i < 10_000; i++) {
      const source = Array.from({ length: 1 + random(4) }, line).join("\n");
      if (agrees(source)) taken++;
    }
    // The generator is hostile on purpose; this only proves the comparison is not vacuous.
    expect(taken).toBeGreaterThan(500);
  });
});
