/** The frontmatter most entries have, `key: scalar` lines and one-line lists, read without the full YAML parser. */

import { put } from "./shape.js";

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/;
// oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;
/** What a plain scalar may not begin with: every YAML indicator. */
const INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;
const FLOW_INDICATOR = /[[\]{}]/;
const SIMPLE_INT = /^-?(?:0|[1-9][0-9]{0,14})$/;
const SIMPLE_FLOAT = /^-?(?:0|[1-9][0-9]{0,14})\.[0-9]{1,15}$/;
/** The YAML 1.2 core schema's numbers, as the `yaml` package tests for them. */
const CORE_NUMBER = [
  /^0o[0-7]+$/,
  /^[-+]?[0-9]+$/,
  /^0x[0-9a-fA-F]+$/,
  /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
];
const WORDS = new Map<string, unknown>([
  ["true", true],
  ["false", false],
  ["null", null],
  ["~", null],
]);
/** Spellings the core schema also reads as a boolean or null, and a key that is not a plain name. */
const RARE = new Set(["True", "TRUE", "False", "FALSE", "Null", "NULL", "__proto__"]);

/** Says "not something I read": the caller falls back to the YAML parser, which decides. */
export const NOT_FLAT: unique symbol = Symbol("not flat");

function scalar(text: string, inFlow: boolean): unknown {
  if (text === "" || UNPRINTABLE.test(text)) return NOT_FLAT;
  const first = text[0];
  if (first === '"' || first === "'") {
    if (text.length < 2 || text.at(-1) !== first) return NOT_FLAT;
    const inner = text.slice(1, -1);
    return inner.includes('"') || inner.includes("'") || inner.includes("\\") ? NOT_FLAT : inner;
  }
  if (WORDS.has(text)) return WORDS.get(text);
  if (RARE.has(text)) return NOT_FLAT;
  if (CORE_NUMBER.some((pattern) => pattern.test(text))) {
    if (text === "-0") return NOT_FLAT;
    return SIMPLE_INT.test(text) || SIMPLE_FLOAT.test(text) ? Number(text) : NOT_FLAT;
  }
  if (INDICATOR_START.test(text)) return NOT_FLAT;
  if (text.includes(": ") || text.includes(" #") || text.endsWith(":")) return NOT_FLAT;
  if (inFlow && FLOW_INDICATOR.test(text)) return NOT_FLAT;
  return text;
}

/** Spaces only: a no-break space is content to YAML, where `trim()` would drop it. */
function trimSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === " ") start++;
  while (end > start && text[end - 1] === " ") end--;
  return text.slice(start, end);
}

function value(text: string): unknown {
  if (text === "") return null;
  if (text[0] !== "[") return scalar(text, false);
  if (text.at(-1) !== "]") return NOT_FLAT;
  const inner = trimSpaces(text.slice(1, -1));
  if (inner === "") return [];
  const items: unknown[] = [];
  for (const part of inner.split(",")) {
    const item = scalar(trimSpaces(part), true);
    if (item === NOT_FLAT) return NOT_FLAT;
    items.push(item);
  }
  return items;
}

/** The mapping the text holds, or `NOT_FLAT` for anything beyond one-line keys and values. */
export function parseFlatYaml(source: string): Record<string, unknown> | typeof NOT_FLAT {
  const out: Record<string, unknown> = {};
  let start = 0;
  while (start < source.length) {
    let end = source.indexOf("\n", start);
    if (end === -1) end = source.length;
    const line = source.slice(start, end);
    start = end + 1;
    if (line === "") continue;
    const match = KEY_LINE.exec(line);
    if (!match) return NOT_FLAT;
    const key = match[1]!;
    if (RARE.has(key) || WORDS.has(key) || Object.hasOwn(out, key)) return NOT_FLAT;
    const parsed = value(trimSpaces(match[2] ?? ""));
    if (parsed === NOT_FLAT) return NOT_FLAT;
    put(out, key, parsed);
  }
  return out;
}
