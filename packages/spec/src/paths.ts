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

export function collectionEntryPath(
  config: CmsConfig,
  collection: { path: string; format: "markdown" | "json" },
  slug: string,
): string {
  const ext = collection.format === "markdown" ? "md" : "json";
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
