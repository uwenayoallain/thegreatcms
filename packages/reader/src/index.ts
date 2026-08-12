/**
 * @greatcms/reader — read managed content at build time.
 *
 * Deliberately framework-neutral. Astro, Next, Eleventy, Nuxt, and plain Node
 * scripts all use this same reader, because there is nothing framework-specific
 * about reading a JSON file. If this package ever needs a framework-specific
 * sibling, something has gone wrong with the standard.
 *
 * Everything here is synchronous filesystem work that happens during a build, so
 * a site ships zero CMS JavaScript to the browser.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type CmsConfig,
  type CmsSchema,
  type CollectionDef,
  DEFAULT_CONFIG,
  type RegionDocument,
  parseConfig,
  parseFrontmatter,
  parseRegionFile,
  parseSchema,
  regionFilePath,
  resolveRegion,
} from '@greatcms/spec';

export interface ReaderOptions {
  /** Site root — the directory containing `.cms/`. Defaults to `process.cwd()`. */
  root?: string;
  /**
   * Throw when a region is missing from the schema. On by default: a typo in a
   * region id should fail the build, not silently render nothing.
   */
  strictRegions?: boolean;
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
  private readonly cache = new Map<string, RegionDocument | null>();

  constructor(options: ReaderOptions = {}) {
    this.root = resolve(options.root ?? process.cwd());
    this.strictRegions = options.strictRegions ?? true;

    const schemaFile = firstExisting(this.root, [
      '.cms/schema.json',
      '.cms/schema.yaml',
      '.cms/schema.yml',
    ]);
    if (!schemaFile) {
      throw new Error(
        `No .cms/schema.yaml found under ${this.root}.\n  fix: run \`greatcms init\`, or pass { root } pointing at the directory that contains .cms/`,
      );
    }
    this.schema = parseSchema(readFileSync(join(this.root, schemaFile), 'utf8'), {
      file: schemaFile,
    });

    const configFile = firstExisting(this.root, [
      '.cms/config.json',
      '.cms/config.yaml',
      '.cms/config.yml',
    ]);
    this.config = configFile
      ? parseConfig(readFileSync(join(this.root, configFile), 'utf8'), configFile)
      : DEFAULT_CONFIG;
  }

  /**
   * Resolves a region: schema defaults, then the stored file layered on top.
   * A region with no content file yet returns its defaults, which is what makes
   * a site buildable before the CMS has ever touched it.
   */
  region<T = RegionDocument>(regionId: string): T {
    if (this.cache.has(regionId)) return this.cache.get(regionId) as T;

    if (!(regionId in this.schema.regions)) {
      if (this.strictRegions) {
        throw new Error(
          `Unknown region "${regionId}".\n  fix: add it under \`regions:\` in .cms/schema.yaml, or correct the id here.\n  known regions: ${Object.keys(this.schema.regions).join(', ') || '(none)'}`,
        );
      }
      this.cache.set(regionId, null);
      return null as T;
    }

    const relative = regionFilePath(this.config, regionId);
    const absolute = join(this.root, relative);
    let stored: RegionDocument | null = null;
    if (existsSync(absolute)) {
      stored = parseRegionFile(readFileSync(absolute, 'utf8'), relative);
    }

    const resolved = resolveRegion(this.schema, regionId, stored);
    this.cache.set(regionId, resolved);
    return resolved as T;
  }

  /** Blocks of a blocks region, ready to map onto components. */
  blocks<T = Record<string, unknown>>(regionId: string): Array<T & { _type: string }> {
    const document = this.region<RegionDocument>(regionId);
    const blocks = document?.blocks;
    return Array.isArray(blocks) ? (blocks as Array<T & { _type: string }>) : [];
  }

  /** Every region id the schema defines. */
  regionIds(): string[] {
    return Object.keys(this.schema.regions);
  }

  collection(name: string): CollectionEntry[] {
    const def: CollectionDef | undefined = this.schema.collections[name];
    if (!def) {
      throw new Error(
        `Unknown collection "${name}".\n  fix: add it under \`collections:\` in .cms/schema.yaml.\n  known collections: ${Object.keys(this.schema.collections).join(', ') || '(none)'}`,
      );
    }

    const dir = join(this.root, def.path);
    if (!existsSync(dir)) return [];

    const extension = def.format === 'markdown' ? '.md' : '.json';
    const entries: CollectionEntry[] = [];

    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(extension)) continue;
      const relative = `${def.path.replace(/\/+$/, '')}/${file}`;
      const source = readFileSync(join(dir, file), 'utf8');
      const slug = file.slice(0, -extension.length);

      if (def.format === 'json') {
        entries.push({ slug, file: relative, data: JSON.parse(source), body: '' });
        continue;
      }

      const { data, body } = parseFrontmatter(source, relative);
      // The body field is a normal field as far as consumers are concerned; the
      // Markdown body is simply where it is stored.
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

export type { RegionDocument } from '@greatcms/spec';
