/** Defaults and fallback: the mechanics of the hybrid model. */

import type { FieldDef } from "./fields.js";
import { boundedDepth } from "./errors.js";
import {
  type BlockDef,
  type CmsSchema,
  type RegionDef,
  blockVariants,
  isBlocksRegion,
} from "./schema.js";
import { own, set } from "./shape.js";

export type RegionDocument = Record<string, unknown>;

export interface RegionMeta {
  updatedAt?: string;
  updatedBy?: string;
  /** Spec version the document was written with. */
  version?: number;
}

/** Defaults declared on the fields themselves. */
export function fieldDefaults(fields: Record<string, FieldDef>): RegionDocument {
  const out: RegionDocument = {};
  for (const [name, def] of Object.entries(fields)) {
    if (def.type === "group") {
      const nested = fieldDefaults(def.fields);
      if (Object.keys(nested).length > 0) set(out, name, nested);
      continue;
    }
    if (def.type === "list") {
      continue; // an empty list is the only sensible default
    }
    if (def.type === "blocks") {
      if (def.default) set(out, name, def.default);
      continue;
    }
    if (def.type === "reference") {
      if (def.multiple) set(out, name, []);
      continue;
    }
    if ("default" in def && def.default !== undefined) {
      set(out, name, def.default);
    }
  }
  return out;
}

/** What a region renders as when no content file exists yet. */
export function regionDefaults(schema: CmsSchema, regionId: string): RegionDocument | null {
  return resolveRegion(schema, regionId, null);
}

function defaultsFor(region: RegionDef): RegionDocument {
  if (isBlocksRegion(region)) {
    return { blocks: region.default ?? [] };
  }
  return deepMerge(fieldDefaults(region.fields), region.default ?? {});
}

/** Merges stored content over schema defaults. */
export function resolveRegion(
  schema: CmsSchema,
  regionId: string,
  stored: RegionDocument | null | undefined,
): RegionDocument | null {
  const region = own(schema.regions, regionId) as RegionDef | undefined;
  if (!region) return null;
  return boundedDepth(undefined, () => {
    const defaults = defaultsFor(region);
    const document = stored ?? {};
    if (isBlocksRegion(region)) {
      const blocks = document.blocks;
      if (!Array.isArray(blocks)) return defaults;
      return { ...document, blocks: blocks.map((block) => resolveBlock(schema, block)) };
    }
    return resolveNested(schema, region.fields, deepMerge(defaults, document));
  });
}

/**
 * One block, with its own field defaults filled in: and then the same again
 * for any block nested inside it. Resolution has to reach every depth the
 * content actually has, or a nested block renders without its defaults.
 */
function resolveBlock(schema: CmsSchema, block: unknown): unknown {
  if (!isPlainObject(block)) return block;
  const type = own(block, "_type");
  const def =
    typeof type === "string" ? (own(schema.blocks, type) as BlockDef | undefined) : undefined;
  if (!def) return block;
  const resolved = resolveNested(schema, def.fields, deepMerge(fieldDefaults(def.fields), block));
  // A block with variants always has one: the first, unless the content names another.
  const variants = blockVariants(def);
  if (variants.length > 0) {
    const named = own(resolved, "_variant");
    resolved._variant = variants.some((v) => v.value === named) ? named : variants[0]!.value;
  }
  return resolved;
}

/** Walks a document's `blocks` fields, resolving what is inside them. */
function resolveNested(
  schema: CmsSchema,
  fields: Record<string, FieldDef>,
  document: RegionDocument,
): RegionDocument {
  const out: RegionDocument = { ...document };
  for (const [name, def] of Object.entries(fields)) {
    if (def.type !== "blocks" && def.type !== "group") continue;
    const value = own(out, name);
    if (def.type === "blocks" && Array.isArray(value)) {
      set(
        out,
        name,
        value.map((entry) => resolveBlock(schema, entry)),
      );
    } else if (def.type === "group" && isPlainObject(value)) {
      set(out, name, resolveNested(schema, def.fields, value));
    }
  }
  return out;
}

function deepMerge(base: RegionDocument, over: RegionDocument): RegionDocument {
  const out: RegionDocument = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const existing = own(out, key);
    set(
      out,
      key,
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value,
    );
  }
  return out;
}

function isPlainObject(value: unknown): value is RegionDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serializes a JSON content file for commit: keys sorted at every depth, machinery last,
 * two-space indent, trailing newline. Regions and JSON collection entries both use it.
 */
export function serializeRegion(document: RegionDocument, meta?: RegionMeta): string {
  return boundedDepth(undefined, () => {
    const ordered = sortKeys(document) as RegionDocument;
    if (meta) ordered._meta = sortKeys(meta) as RegionMeta;
    return `${JSON.stringify(ordered, null, 2)}\n`;
  });
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const ordered: RegionDocument = {};
  for (const key of Object.keys(value).toSorted(machineryLast)) {
    set(ordered, key, sortKeys(value[key]));
  }
  return ordered;
}

/** Keys beginning with `_` are machinery (`_meta`, `_type`). Code-point order, so every language agrees. */
function machineryLast(a: string, b: string): number {
  const am = a.startsWith("_");
  const bm = b.startsWith("_");
  if (am !== bm) return am ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseRegionFile(source: string, file: string): RegionDocument {
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object.");
    }
    return parsed as RegionDocument;
  } catch (err) {
    const reason = err instanceof RangeError ? "it is nested too deeply" : (err as Error).message;
    throw new Error(`${file}: could not read region content: ${reason}`, { cause: err });
  }
}
