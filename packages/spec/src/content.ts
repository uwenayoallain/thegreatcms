/** Defaults and fallback — the mechanics of the hybrid model. */

import type { FieldDef } from "./fields.js";
import { type CmsSchema, type RegionDef, isBlocksRegion } from "./schema.js";

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
      if (Object.keys(nested).length > 0) out[name] = nested;
      continue;
    }
    if (def.type === "list") {
      continue; // an empty list is the only sensible default
    }
    if (def.type === "blocks") {
      if (def.default) out[name] = def.default;
      continue;
    }
    if ("default" in def && def.default !== undefined) {
      out[name] = def.default;
    }
  }
  return out;
}

/** What a region renders as when no content file exists yet. */
export function regionDefaults(schema: CmsSchema, regionId: string): RegionDocument | null {
  const region = schema.regions[regionId];
  if (!region) return null;
  return defaultsFor(region);
}

function defaultsFor(region: RegionDef): RegionDocument {
  if (isBlocksRegion(region)) {
    return { blocks: region.default ?? [] };
  }
  return { ...fieldDefaults(region.fields), ...region.default };
}

/** Merges stored content over schema defaults. */
export function resolveRegion(
  schema: CmsSchema,
  regionId: string,
  stored: RegionDocument | null | undefined,
): RegionDocument | null {
  const region = schema.regions[regionId];
  if (!region) return null;
  const defaults = defaultsFor(region);
  if (!stored) return defaults;
  if (isBlocksRegion(region)) {
    if (!Array.isArray(stored.blocks)) return defaults;
    // Blocks get the same treatment as regions: defaults from the block's own fields fill.
    const blocks = stored.blocks.map((block) => {
      const type = (block as { _type?: unknown })?._type;
      const def = typeof type === "string" ? schema.blocks[type] : undefined;
      if (!def || !isPlainObject(block)) return block;
      return deepMerge(fieldDefaults(def.fields), block);
    });
    return { ...stored, blocks };
  }
  return deepMerge(defaults, stored);
}

function deepMerge(base: RegionDocument, over: RegionDocument): RegionDocument {
  const out: RegionDocument = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is RegionDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Serializes a region document for commit: stable key order, trailing newline. */
export function serializeRegion(document: RegionDocument, meta?: RegionMeta): string {
  const ordered: RegionDocument = {};
  for (const key of Object.keys(document).toSorted(machineryLast)) {
    ordered[key] = document[key];
  }
  if (meta) ordered._meta = meta;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Keys beginning with `_` are machinery (`_meta`, `_type`). */
function machineryLast(a: string, b: string): number {
  const am = a.startsWith("_");
  const bm = b.startsWith("_");
  if (am !== bm) return am ? 1 : -1;
  return a.localeCompare(b);
}

export function parseRegionFile(source: string, file: string): RegionDocument {
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object.");
    }
    return parsed as RegionDocument;
  } catch (err) {
    throw new Error(`${file}: could not read region content — ${(err as Error).message}`, {
      cause: err,
    });
  }
}
