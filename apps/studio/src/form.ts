/** Form data ↔ content documents. */

import type { FieldDef } from "@greatcms/spec";

export const ROOT = "f";
/** Namespace for file inputs, kept separate from text so decoding stays simple. */
export const MEDIA_ROOT = "m";

/** `f[seo][title]` → ['seo', 'title'] */
export function parsePath(name: string, root: string = ROOT): string[] | null {
  const match = /^([^[\]]+)((\[[^[\]]*\])*)$/.exec(name);
  if (!match) return null;
  const [, head = "", rest = ""] = match;
  if (head !== root) return null;
  const segments = [...rest.matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1] ?? "");
  return segments.every((segment) => segment !== "") ? segments : null;
}

export function fieldName(path: Array<string | number>, root: string = ROOT): string {
  return root + path.map((segment) => `[${segment}]`).join("");
}

/** Builds a nested document from submitted form entries, coercing each value according to its. */
export function decodeForm(
  entries: Iterable<[string, string]>,
  fields: Record<string, FieldDef>,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};

  for (const [name, value] of entries) {
    const path = parsePath(name);
    if (!path) continue;
    setPath(raw, path, value);
  }

  return coerceFields(raw, fields);
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
  node[path.at(-1) as string] = value;
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
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(fields)) {
    const value = coerceField(def, raw[name]);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function coerceField(def: FieldDef, value: unknown): unknown {
  switch (def.type) {
    case "text":
    case "date": {
      const text = asString(value);
      // An empty box means "no value", not an empty string that overwrites a default.
      return text === "" ? undefined : text;
    }

    case "richtext": {
      const html = asString(value && typeof value === "object" ? (value as never)["html"] : value);
      return html === "" ? undefined : { html };
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

    case "list": {
      const list = toArrayIfIndexed(value);
      if (!Array.isArray(list)) return [];
      return list.map((item) => coerceField(def.of, item)).filter((item) => item !== undefined);
    }

    case "group":
      return coerceFields(asObject(value), def.fields);
  }
}

/** Blocks carry `_type` alongside their fields, and each block's shape depends on it —. */
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
    blocks.push({ _type: type, ...coerceFields(object, fields) });
  }
  return blocks;
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
