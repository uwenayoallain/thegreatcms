/** Form data ↔ content documents. */

import { offsetSuffix, studioTimeZone } from "./schedule.js";
import { sanitizeRichText } from "./sanitize.js";
import type { FieldDef } from "@greatcms/spec";

export const ROOT = "f";
/** The hidden sibling of a date-and-time input that keeps the value's UTC offset: `f[date~zone]`. */
export const ZONE_SUFFIX = "~zone";
/** Namespace for file inputs, kept separate from text so decoding stays simple. */
export const MEDIA_ROOT = "m";

/** `f[seo][title]` → ['seo', 'title'] */
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function parsePath(name: string, root: string = ROOT): string[] | null {
  const match = /^([^[\]]+)((\[[^[\]]*\])*)$/.exec(name);
  if (!match) return null;
  const [, head = "", rest = ""] = match;
  if (head !== root) return null;
  const segments = [...rest.matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1] ?? "");
  // A segment naming the prototype chain would write into every object in the process.
  const safe = segments.every((segment) => segment !== "" && !UNSAFE_KEYS.has(segment));
  return safe ? segments : null;
}

export function fieldName(path: Array<string | number>, root: string = ROOT): string {
  return root + path.map((segment) => `[${segment}]`).join("");
}

/** Resolves a block name to its fields, for nested `blocks` fields. */
export type BlockFields = (type: string) => Record<string, FieldDef> | undefined;

/** Builds a nested document from submitted form entries, coercing each value according to its field type. */
/** `verbatim` names a top-level rich-text field kept as typed: an MDX body is source, not HTML. */
export function decodeForm(
  entries: Iterable<[string, string]>,
  fields: Record<string, FieldDef>,
  blockFields?: BlockFields,
  verbatim?: string,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};

  for (const [name, value] of entries) {
    const path = parsePath(name);
    if (!path) continue;
    setPath(raw, path, value);
  }

  return coerceFields(raw, fields, blockFields, verbatim);
}

function setPath(target: Record<string, unknown>, path: string[], value: string): void {
  let node: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i] as string;
    const existing = node[key];
    if (typeof existing !== "object" || existing === null) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  // A name sent more than once, as a multiple choice sends each ticked value, collects them all.
  const leaf = path.at(-1) as string;
  const prior = node[leaf];
  node[leaf] =
    typeof prior === "string" ? [prior, value] : Array.isArray(prior) ? [...prior, value] : value;
}

/** Numeric keys mean the author was editing a list. */
function toArrayIfIndexed(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0 || !keys.every((key) => /^\d+$/.test(key))) return value;
  return keys
    .map(Number)
    .toSorted((a, b) => a - b)
    .map((index) => (value as Record<string, unknown>)[String(index)]);
}

function coerceFields(
  raw: Record<string, unknown>,
  fields: Record<string, FieldDef>,
  blockFields?: BlockFields,
  verbatim?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(fields)) {
    const typed =
      def.type === "date" && def.time ? withZone(raw[name], raw[name + ZONE_SUFFIX]) : raw[name];
    const value = coerceField(def, typed, blockFields, name !== verbatim);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * A browser's date-and-time box sends wall time with no zone, which a site built
 * on another machine would read in its own. The offset the value had goes back
 * on, and a new value takes the studio's zone, so the instant is the one typed.
 */
function withZone(value: unknown, zone: unknown): unknown {
  const local = asString(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return value;
  const kept = asString(zone);
  // A value saved without an offset stays that way: it was never this form's to reinterpret.
  if (kept === "local") return local;
  const suffix = /^(Z|[+-]\d{2}:\d{2})$/.test(kept) ? kept : offsetSuffix(local, studioTimeZone());
  return `${local}:00${suffix}`;
}

function coerceField(
  def: FieldDef,
  value: unknown,
  blockFields?: BlockFields,
  sanitize = true,
): unknown {
  switch (def.type) {
    case "text":
    case "date": {
      const text = asString(value);
      // An empty box means "no value", not an empty string that overwrites a default.
      return text === "" ? undefined : text;
    }

    case "richtext": {
      const typed = asString(value && typeof value === "object" ? (value as never)["html"] : value);
      const html = sanitize ? sanitizeRichText(typed) : typed;
      return html.trim() === "" ? undefined : { html };
    }

    case "number": {
      const text = asString(value);
      if (text === "") return undefined;
      const parsed = Number(text);
      // A number that will not parse is passed through as-is so the validator can.
      return Number.isNaN(parsed) ? text : parsed;
    }

    case "boolean":
      // Unchecked checkboxes submit nothing at all.
      return asString(value) !== "";

    case "select": {
      if (def.multiple) {
        const list = toArrayIfIndexed(value);
        if (typeof list === "string") return list === "" ? [] : [list];
        return Array.isArray(list) ? list.map(asString).filter(Boolean) : [];
      }
      const text = asString(value);
      return text === "" ? undefined : text;
    }

    case "link": {
      const object = asObject(value);
      const href = asString(object.href);
      if (href === "") return undefined;
      const label = asString(object.label);
      return {
        href,
        ...(label === "" ? {} : { label }),
        ...(isExternal(href) ? { external: true } : {}),
      };
    }

    case "image": {
      const object = asObject(value);
      const src = asString(object.src);
      if (src === "") return undefined;
      const width = Number(asString(object.width));
      const height = Number(asString(object.height));
      return {
        src,
        alt: asString(object.alt),
        ...(Number.isFinite(width) && width > 0 ? { width } : {}),
        ...(Number.isFinite(height) && height > 0 ? { height } : {}),
      };
    }

    case "file": {
      const object = asObject(value);
      const src = asString(object.src);
      return src === "" ? undefined : { src };
    }

    case "reference": {
      if (!def.multiple) {
        const slug = asString(value);
        return slug === "" ? undefined : slug;
      }
      const list = toArrayIfIndexed(value);
      const slugs = Array.isArray(list) ? list.map(asString) : asString(list).split(",");
      return slugs.map((slug) => slug.trim()).filter(Boolean);
    }

    case "list": {
      const list = toArrayIfIndexed(value);
      if (!Array.isArray(list)) return [];
      return list
        .map((item) => coerceField(def.of, item, blockFields))
        .filter((item) => item !== undefined);
    }

    case "blocks": {
      const list = toArrayIfIndexed(value);
      if (!Array.isArray(list)) return [];
      const blocks: Array<Record<string, unknown>> = [];
      for (const entry of list) {
        const object = asObject(entry);
        const type = asString(object._type);
        if (!def.allow.includes(type)) continue;
        const nested = blockFields?.(type);
        if (!nested) continue; // a type the schema no longer defines
        blocks.push({
          _type: type,
          ...variantOf(object),
          ...coerceFields(object, nested, blockFields),
        });
      }
      return blocks;
    }

    case "group":
      return coerceFields(asObject(value), def.fields, blockFields);
  }
}

/** Blocks carry `_type` alongside their fields, and each block's shape depends on it. */
export function decodeBlocks(
  entries: Iterable<[string, string]>,
  blockFields: (type: string) => Record<string, FieldDef> | undefined,
): Array<Record<string, unknown>> {
  const raw: Record<string, unknown> = {};
  for (const [name, value] of entries) {
    const path = parsePath(name);
    if (!path || path[0] !== "blocks") continue;
    setPath(raw, path, value);
  }

  const list = toArrayIfIndexed(raw.blocks);
  if (!Array.isArray(list)) return [];

  const blocks: Array<Record<string, unknown>> = [];
  for (const entry of list) {
    const object = asObject(entry);
    const type = asString(object._type);
    const fields = blockFields(type);
    if (!fields) continue; // a block type the schema no longer knows about
    blocks.push({
      _type: type,
      ...variantOf(object),
      ...coerceFields(object, fields, blockFields),
    });
  }
  return blocks;
}

/** The look an editor picked for a block, when the form offered one. */
function variantOf(object: Record<string, unknown>): { _variant?: string } {
  const variant = asString(object._variant);
  return variant ? { _variant: variant } : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}
