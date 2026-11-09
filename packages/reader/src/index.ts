/** @greatcms/reader: read managed content at build time. */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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
  /** Site root: the directory containing `.cms/`. Defaults to `process.cwd()`. */
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
 * and disappear for one that has: so an unknown id is a compile error there
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

/** The largest `.cms` file and the largest content file a reader takes on. */
const MAX_DEFINITION_BYTES = 4 * 1024 * 1024;
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;

/** In development a file must have sat unchanged this long before its parse is kept. */
const SETTLED_MS = 2000;

/** Parsed files, shared by every reader in the process and trusted only while the file is unchanged. */
const parsedFiles = new Map<string, { stamp: string; value: unknown }>();

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function tooLarge(file: string, size: number, limit: number): Error {
  return new Error(
    `${file} is ${mb(size)}, and the reader takes files up to ${mb(limit)}.\n  fix: split it into smaller files; media belongs in the media folder, not inside content.`,
  );
}

export class CmsReader {
  readonly root: string;
  readonly schema: CmsSchema;
  readonly config: CmsConfig;
  private readonly strictRegions: boolean;
  private readonly drafts: boolean;
  private readonly cache = new Map<string, RegionDocument | null>();
  private readonly entryCache = new Map<string, CollectionEntry[]>();
  private realRoot: string | undefined;

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
    this.schema = this.definition(schemaFile, (source) =>
      parseSchema(source, { file: schemaFile }),
    );

    const configFile = firstExisting(this.root, [
      ".cms/config.json",
      ".cms/config.yaml",
      ".cms/config.yml",
    ]);
    this.config = configFile
      ? this.definition(configFile, (source) => parseConfig(source, configFile))
      : DEFAULT_CONFIG;
  }

  /** The schema or config, parsed once per process however many readers a build creates. */
  private definition<T>(file: string, parse: (source: string) => T): T {
    const absolute = join(this.root, file);
    const stat = statSync(absolute);
    if (stat.size > MAX_DEFINITION_BYTES) throw tooLarge(file, stat.size, MAX_DEFINITION_BYTES);
    return this.remembered(absolute, stat, () => parse(readFileSync(absolute, "utf8")));
  }

  /** `produce()`, or what it gave last time if the file has not changed since. */
  private remembered<T>(
    absolute: string,
    stat: { mtimeMs: number; size: number; ino: number },
    produce: () => T,
  ): T {
    // Keyed by root too: a link that stays inside one site's root may leave another's.
    const key = `${this.root}\0${absolute}`;
    const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    // Two edits inside one tick of the clock share a stamp, so in dev a fresh file is read again.
    const trusted = !this.drafts || Date.now() - stat.mtimeMs > SETTLED_MS;
    const hit = parsedFiles.get(key);
    if (trusted && hit?.stamp === stamp) return hit.value as T;
    const value = produce();
    parsedFiles.set(key, { stamp, value });
    return value;
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
    const stored = this.read(relative, (source) => parseRegionFile(source, relative));

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

  /** A file, parsed, taking an unsaved draft over the committed copy. */
  private read<T>(relative: string, parse: (source: string) => T): T | null {
    if (this.drafts) {
      const draft = this.readInside(join(this.root, draftFilePath(relative)), relative, parse);
      if (draft !== null) return draft;
    }
    return this.readInside(join(this.root, relative), relative, parse);
  }

  /** Null for a file that is missing, unreadable, or a link to somewhere outside the site root. */
  private readInside<T>(
    absolute: string,
    relative: string,
    parse: (source: string) => T,
  ): T | null {
    const stat = statSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile()) return null;
    if (stat.size > MAX_CONTENT_BYTES) throw tooLarge(relative, stat.size, MAX_CONTENT_BYTES);
    return this.remembered(absolute, stat, () => {
      const source = this.sourceInside(absolute);
      return source === null ? null : parse(source);
    });
  }

  private sourceInside(absolute: string): string | null {
    try {
      this.realRoot ??= realpathSync(this.root);
      const realFile = realpathSync(absolute);
      if (!realFile.startsWith(this.realRoot + sep)) return null;
      return readFileSync(realFile, "utf8");
    } catch {
      return null;
    }
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

    const base = def.path.replace(/\/+$/, "");
    for (const file of readdirSync(dir).toSorted()) {
      if (!file.endsWith(extension)) continue;
      const relative = `${base}/${file}`;
      const slug = file.slice(0, -extension.length);
      const entry = this.read(relative, (source) => readEntry(def, slug, relative, source));
      if (entry !== null) entries.push(entry);
    }

    return entries;
  }
}

function readEntry(
  def: CollectionDef,
  slug: string,
  file: string,
  source: string,
): CollectionEntry {
  if (def.format === "json") return { slug, file, data: parseRegionFile(source, file), body: "" };
  const { data, body } = parseFrontmatter(source, file);
  // The body is a normal field to consumers; Markdown is only where it is stored.
  if (def.body) data[def.body] = body;
  return { slug, file, data, body };
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
