/** @greatcms/reader — read managed content at build time. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type CmsConfig,
  type CmsSchema,
  type CollectionDef,
  DEFAULT_CONFIG,
  draftFilePath,
  type RegionDocument,
  parseConfig,
  parseFrontmatter,
  parseRegionFile,
  parseSchema,
  regionFilePath,
  resolveRegion,
  entryExtension,
} from "@greatcms/spec";

export interface ReaderOptions {
  /** Site root — the directory containing `.cms/`. Defaults to `process.cwd()`. */
  root?: string;
  /** Throw when a region is missing from the schema. */
  strictRegions?: boolean;
  /** Prefer unsaved edits from `.cms/draft/` over the committed file, so the studio can show. */
  drafts?: boolean;
}

/**
 * Ids this site defines, filled in by the file `greatcms types` generates.
 * Empty here on purpose: with no augmentation in scope the reader still takes
 * any string, so a site that never runs the generator is unaffected.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by generated code
export interface GreatCMSRegions {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by generated code
export interface GreatCMSCollections {}

/**
 * True until a generated file augments `GreatCMSRegions`. It is what lets the
 * loose `string` overload exist for a site that has not run `greatcms types`,
 * and disappear for one that has — so an unknown id is a compile error there
 * rather than `undefined` at build time.
 */
type NoRegionsDeclared = [keyof GreatCMSRegions] extends [never] ? true : false;
type NoCollectionsDeclared = [keyof GreatCMSCollections] extends [never] ? true : false;

/** The stored shapes, named so generated types can refer to them. */
export interface RichText {
  html: string;
  _ast?: unknown;
}

export interface CmsLink {
  href: string;
  label?: string;
  external?: boolean;
}

export interface CmsImage {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface CmsFile {
  src: string;
  name?: string;
  size?: number;
}

export interface CollectionEntry {
  /** File-name slug, e.g. `publish-from-anywhere`. */
  slug: string;
  /** Repo-relative path of the entry. */
  file: string;
  /** Frontmatter fields, with the body field populated for Markdown entries. */
  data: Record<string, unknown>;
  /** Raw Markdown body, empty for JSON collections. */
  body: string;
}

export class CmsReader {
  readonly root: string;
  readonly schema: CmsSchema;
  readonly config: CmsConfig;
  private readonly strictRegions: boolean;
  private readonly drafts: boolean;
  private readonly cache = new Map<string, RegionDocument | null>();
  private readonly entryCache = new Map<string, CollectionEntry[]>();

  constructor(options: ReaderOptions = {}) {
    this.root = resolve(options.root ?? process.cwd());
    this.strictRegions = options.strictRegions ?? true;
    this.drafts = options.drafts ?? process.env.NODE_ENV === "development";

    const schemaFile = firstExisting(this.root, [
      ".cms/schema.json",
      ".cms/schema.yaml",
      ".cms/schema.yml",
    ]);
    if (!schemaFile) {
      throw new Error(
        `No .cms/schema.yaml found under ${this.root}.\n  fix: run \`greatcms init\`, or pass { root } pointing at the directory that contains .cms/`,
      );
    }
    this.schema = parseSchema(readFileSync(join(this.root, schemaFile), "utf8"), {
      file: schemaFile,
    });

    const configFile = firstExisting(this.root, [
      ".cms/config.json",
      ".cms/config.yaml",
      ".cms/config.yml",
    ]);
    this.config = configFile
      ? parseConfig(readFileSync(join(this.root, configFile), "utf8"), configFile)
      : DEFAULT_CONFIG;
  }

  /** Resolves a region: schema defaults, then the stored file layered on top. */
  region<K extends keyof GreatCMSRegions>(regionId: K): GreatCMSRegions[K];
  region<T = RegionDocument>(regionId: NoRegionsDeclared extends true ? string : never): T;
  region(regionId: string): unknown {
    // The cache is a build-time optimisation; in dev it would pin the content to startup.
    if (!this.drafts && this.cache.has(regionId)) return this.cache.get(regionId);

    if (!(regionId in this.schema.regions)) {
      if (this.strictRegions) {
        throw new Error(
          `Unknown region "${regionId}".\n  fix: add it under \`regions:\` in .cms/schema.yaml, or correct the id here.\n  known regions: ${Object.keys(this.schema.regions).join(", ") || "(none)"}`,
        );
      }
      this.cache.set(regionId, null);
      return null;
    }

    const relative = regionFilePath(this.config, regionId);
    const source = this.read(relative);
    const stored = source === null ? null : parseRegionFile(source, relative);

    const resolved = resolveRegion(this.schema, regionId, stored);
    this.cache.set(regionId, resolved);
    return resolved;
  }

  /** Blocks of a blocks region, ready to map onto components. */
  blocks<T = Record<string, unknown>>(regionId: string): Array<T & { _type: string }> {
    const document = this.region<RegionDocument>(regionId);
    const blocks = document?.blocks;
    return Array.isArray(blocks) ? (blocks as Array<T & { _type: string }>) : [];
  }

  /** A file's contents, taking an unsaved draft over the committed copy. */
  private read(relative: string): string | null {
    if (this.drafts) {
      const draft = join(this.root, draftFilePath(relative));
      if (existsSync(draft)) return readFileSync(draft, "utf8");
    }
    const absolute = join(this.root, relative);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  }

  /** Every region id the schema defines. */
  regionIds(): string[] {
    return Object.keys(this.schema.regions);
  }

  collection<K extends keyof GreatCMSCollections>(name: K): Array<GreatCMSCollections[K]>;
  collection(name: NoCollectionsDeclared extends true ? string : never): CollectionEntry[];
  collection(name: string): CollectionEntry[] {
    // Same rule as regions: cached for a build, never in dev, where the whole
    // point is that the next read sees the edit you just made.
    if (!this.drafts) {
      const cached = this.entryCache.get(name);
      if (cached) return cached;
    }
    const entries = this.readCollection(name);
    this.entryCache.set(name, entries);
    return entries;
  }

  private readCollection(name: string): CollectionEntry[] {
    const def: CollectionDef | undefined = this.schema.collections[name];
    if (!def) {
      throw new Error(
        `Unknown collection "${name}".\n  fix: add it under \`collections:\` in .cms/schema.yaml.\n  known collections: ${Object.keys(this.schema.collections).join(", ") || "(none)"}`,
      );
    }

    const dir = join(this.root, def.path);
    if (!existsSync(dir)) return [];

    const extension = `.${entryExtension(def.format)}`;
    const entries: CollectionEntry[] = [];

    for (const file of readdirSync(dir).toSorted()) {
      if (!file.endsWith(extension)) continue;
      const relative = `${def.path.replace(/\/+$/, "")}/${file}`;
      const source = this.read(relative) ?? readFileSync(join(dir, file), "utf8");
      const slug = file.slice(0, -extension.length);

      if (def.format === "json") {
        entries.push({ slug, file: relative, data: JSON.parse(source), body: "" });
        continue;
      }

      const { data, body } = parseFrontmatter(source, relative);
      // The body is a normal field to consumers; Markdown is only where it is stored.
      if (def.body) data[def.body] = body;
      entries.push({ slug, file: relative, data, body });
    }

    return entries;
  }
}

/** Convenience for the common case: one site, rooted at the current directory. */
export function createReader(options: ReaderOptions = {}): CmsReader {
  return new CmsReader(options);
}

function firstExisting(root: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  return null;
}

export type { RegionDocument } from "@greatcms/spec";
