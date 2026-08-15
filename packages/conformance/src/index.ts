/** The conformance kit. */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CmsConfig,
  type CmsSchema,
  type RegionDocument,
  entryExtension,
  parseConfig,
  parseFrontmatter,
  parseRegionFile,
  parseSchema,
  regionFilePath,
  resolveRegion,
} from "@greatcms/spec";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export const FIXTURES_DIR = join(packageRoot, "fixtures");
export const EXPECTED_DIR = join(packageRoot, "expected");

export function fixtureSchema(): CmsSchema {
  return parseSchema(readFileSync(join(FIXTURES_DIR, ".cms/schema.yaml"), "utf8"), {
    file: ".cms/schema.yaml",
  });
}

export function fixtureConfig(): CmsConfig {
  return parseConfig(readFileSync(join(FIXTURES_DIR, ".cms/config.yaml"), "utf8"));
}

/** The documents every conforming reader must produce, keyed by region id. */
export function expectedRegions(): Record<string, RegionDocument> {
  const dir = join(EXPECTED_DIR, "regions");
  const out: Record<string, RegionDocument> = {};
  for (const file of readdirSync(dir).toSorted()) {
    if (!file.endsWith(".json")) continue;
    out[file.slice(0, -".json".length)] = JSON.parse(readFileSync(join(dir, file), "utf8"));
  }
  return out;
}

/** Reference implementation: read the fixture site off disk the way the standard says to. */
export function readFixtureRegion(regionId: string): RegionDocument | null {
  const schema = fixtureSchema();
  const config = fixtureConfig();
  const path = join(FIXTURES_DIR, regionFilePath(config, regionId));
  let stored: RegionDocument | null = null;
  try {
    stored = parseRegionFile(readFileSync(path, "utf8"), path);
  } catch (err) {
    // A missing file is the normal case for a region nobody has edited yet.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && !/ENOENT/.test(String(err))) throw err;
  }
  return resolveRegion(schema, regionId, stored);
}

/** One collection entry, as every conforming reader must produce it. */
export interface ExpectedEntry {
  slug: string;
  data: Record<string, unknown>;
}

/**
 * Entries a reader must produce, keyed `<collection>/<slug>`. Unlike a region,
 * an entry is not layered over schema defaults: what is in the file is what it
 * is. Defaults are an authoring convenience, not a read-time rule.
 */
export function expectedEntries(): Record<string, ExpectedEntry> {
  const root = join(EXPECTED_DIR, "entries");
  const out: Record<string, ExpectedEntry> = {};
  for (const collection of readdirSync(root).toSorted()) {
    const dir = join(root, collection);
    for (const file of readdirSync(dir).toSorted()) {
      if (!file.endsWith(".json")) continue;
      const slug = file.slice(0, -".json".length);
      out[`${collection}/${slug}`] = JSON.parse(readFileSync(join(dir, file), "utf8"));
    }
  }
  return out;
}

/** Reference implementation for collections, matching the reader's rules. */
export function readFixtureEntries(name: string): ExpectedEntry[] {
  const schema = fixtureSchema();
  const def = schema.collections[name];
  if (!def) throw new Error(`Unknown collection "${name}".`);

  const extension = `.${entryExtension(def.format)}`;
  const dir = join(FIXTURES_DIR, def.path);

  return readdirSync(dir)
    .toSorted()
    .filter((file) => file.endsWith(extension))
    .map((file) => {
      const source = readFileSync(join(dir, file), "utf8");
      const slug = file.slice(0, -extension.length);
      if (def.format === "json") {
        return { slug, data: JSON.parse(source) as Record<string, unknown> };
      }
      const { data, body } = parseFrontmatter(source, file);
      if (def.body) data[def.body] = body;
      return { slug, data };
    });
}

export interface Failure {
  regionId: string;
  reason: string;
  expected?: unknown;
  actual?: unknown;
}

export interface ConformanceResult {
  ok: boolean;
  checked: number;
  failures: Failure[];
}

/** Compares resolved documents against the expected set. */
export function verifyRegions(actual: Record<string, unknown>): ConformanceResult {
  const expected = expectedRegions();
  const failures: Failure[] = [];

  for (const [regionId, want] of Object.entries(expected)) {
    if (!(regionId in actual)) {
      failures.push({ regionId, reason: "missing from output" });
      continue;
    }
    const got = stripMeta(actual[regionId]);
    if (!deepEqual(stripMeta(want), got)) {
      failures.push({
        regionId,
        reason: "does not match expected document",
        expected: want,
        actual: got,
      });
    }
  }

  for (const regionId of Object.keys(actual)) {
    if (!(regionId in expected)) {
      failures.push({ regionId, reason: "unexpected region in output" });
    }
  }

  return { ok: failures.length === 0, checked: Object.keys(expected).length, failures };
}

/** Compares collection entries against the expected set. */
export function verifyEntries(actual: Record<string, unknown>): ConformanceResult {
  const expected = expectedEntries();
  const failures: Failure[] = [];

  for (const [key, want] of Object.entries(expected)) {
    if (!(key in actual)) {
      failures.push({ regionId: key, reason: "missing from output" });
      continue;
    }
    const got = stripMeta(actual[key]);
    if (!deepEqual(stripMeta(want), got)) {
      failures.push({
        regionId: key,
        reason: "does not match expected entry",
        expected: want,
        actual: got,
      });
    }
  }

  for (const key of Object.keys(actual)) {
    if (!(key in expected)) {
      failures.push({ regionId: key, reason: "unexpected entry in output" });
    }
  }

  return { ok: failures.length === 0, checked: Object.keys(expected).length, failures };
}

/** Runs the whole kit against a reader function. */
export function runConformance(readRegion: (regionId: string) => unknown): ConformanceResult {
  const actual: Record<string, unknown> = {};
  for (const regionId of Object.keys(expectedRegions())) {
    actual[regionId] = readRegion(regionId);
  }
  return verifyRegions(actual);
}

function stripMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMeta);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === "_meta") continue;
    out[key] = stripMeta(v);
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a as object).toSorted();
  const kb = Object.keys(b as object).toSorted();
  if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
