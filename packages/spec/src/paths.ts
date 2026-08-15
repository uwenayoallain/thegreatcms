/** Deterministic mapping between ids and files. */

import type { CmsConfig } from "./config.js";
import { REGION_ID_RE } from "./schema.js";

export function regionFilePath(config: CmsConfig, regionId: string): string {
  if (!REGION_ID_RE.test(regionId)) {
    throw new Error(
      `Invalid region id "${regionId}". Use dot-separated lowercase segments, e.g. "home.hero".`,
    );
  }
  return `${trimSlashes(config.content.regions)}/${regionId}.json`;
}

export function regionIdFromPath(config: CmsConfig, filePath: string): string | null {
  const dir = `${trimSlashes(config.content.regions)}/`;
  if (!filePath.startsWith(dir) || !filePath.endsWith(".json")) return null;
  const id = filePath.slice(dir.length, -".json".length);
  return REGION_ID_RE.test(id) ? id : null;
}

/** A slug names one file inside the collection, so it is one path segment and nothing else. */
export function isSafeSlug(slug: string): boolean {
  if (slug.length === 0 || slug.length > 120) return false;
  if (slug.startsWith(".")) return false; // ".", "..", and dotfiles
  if (/[/\\]/.test(slug)) return false;
  return ![...slug].some((character) => (character.codePointAt(0) ?? 0) < 0x20);
}

/** How a collection's entries are stored on disk. */
export type CollectionFormat = "markdown" | "mdx" | "json";

/**
 * The file extension for a format. One function so that adding a format is one
 * change rather than a hunt through every consumer for `=== "markdown"`.
 */
export function entryExtension(format: CollectionFormat): string {
  if (format === "json") return "json";
  return format === "mdx" ? "mdx" : "md";
}

/** Formats stored as frontmatter over a prose body, rather than as a data file. */
export function hasFrontmatter(format: CollectionFormat): boolean {
  return format !== "json";
}

export function collectionEntryPath(
  config: CmsConfig,
  collection: { path: string; format: CollectionFormat },
  slug: string,
): string {
  if (!isSafeSlug(slug)) {
    throw new Error(
      `Invalid entry slug ${JSON.stringify(slug)}. A slug names one file inside the collection: no slashes, no leading dot.`,
    );
  }
  const ext = entryExtension(collection.format);
  return `${trimSlashes(collection.path)}/${slug}.${ext}`;
}

/** Where an unsaved edit lives while you are still typing it. */
export const DRAFT_DIR = ".cms/draft";

export function draftFilePath(contentPath: string): string {
  return `${DRAFT_DIR}/${trimSlashes(contentPath)}`;
}

export function mediaFilePath(config: CmsConfig, fileName: string): string {
  return `${trimSlashes(config.content.media)}/${fileName}`;
}

/** Public URL the site will serve a committed media file from. */
export function mediaUrl(config: CmsConfig, fileName: string): string {
  const prefix = config.mediaUrlPrefix.replace(/\/+$/, "");
  return `${prefix}/${fileName}`;
}

/** Slugs land in file names and URLs, so they get the strict treatment: lowercase. */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // strip the accents NFKD just split off
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

function trimSlashes(p: string): string {
  return p.replace(/^\/+|\/+$/g, "");
}
