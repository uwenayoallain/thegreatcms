/** Images chosen in a form: prepared for the commit, kept across a failed save, and previewed. */

import type { CmsConfig } from "@greatcms/spec";
import type { Store } from "./db.js";
import { fieldName, MEDIA_ROOT, parsePath } from "./form.js";
import { prepareUpload, UploadError, type UploadResult } from "./media.js";
import type { FileChange } from "./repo.js";

export async function prepareMediaUploads(
  form: FormData,
  entries: Array<[string, string]>,
  config: CmsConfig,
): Promise<UploadResult[]> {
  const files = [...form.entries()].flatMap(([key, value]) => {
    if (typeof value === "string" || value.size === 0) return [];
    const path = parsePath(key, MEDIA_ROOT);
    return path ? [{ path, file: value }] : [];
  });

  const prepared = await Promise.all(
    files.map(async ({ path, file }) => ({
      path,
      upload: prepareUpload(config, {
        fileName: file.name,
        type: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }),
    })),
  );

  return prepared.map(({ path, upload }) => {
    const field = fieldName(path);
    setEntry(entries, `${field}[src]`, upload.src);
    if (upload.width) setEntry(entries, `${field}[width]`, String(upload.width));
    if (upload.height) setEntry(entries, `${field}[height]`, String(upload.height));
    return upload;
  });
}

/** In place of whatever the form sent under that name: a name sent twice is a list of choices. */
function setEntry(entries: Array<[string, string]>, key: string, value: string): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.[0] === key) entries.splice(index, 1);
  }
  entries.push([key, value]);
}

/** The images an edit was carrying are gone: expired, or the site was reconnected. */
export class ExpiredMediaError extends UploadError {}

export async function retainedMedia(
  store: Store,
  siteId: string,
  scope: string,
  form: FormData,
  entries: Array<[string, string]>,
  config: CmsConfig,
) {
  const previous = String(form.get("pendingMedia") ?? "");
  let kept: UploadResult[] = [];
  try {
    kept = previous ? store.pendingMedia(siteId, scope, previous) : [];
  } catch (error) {
    if (error instanceof UploadError) throw new ExpiredMediaError(error.message, error.fix);
    throw error;
  }
  const added = await prepareMediaUploads(form, entries, config);
  const files = [...new Map([...kept, ...added].map((file) => [file.path, file])).values()];
  const token = added.length
    ? store.savePendingMedia(siteId, scope, files, previous || undefined)
    : previous;
  return { token, files };
}

export function referencedMedia(
  files: UploadResult[],
  document: Record<string, unknown>,
): FileChange[] {
  const sources = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("src" in value && typeof value.src === "string") sources.add(value.src);
    for (const child of Object.values(value)) visit(child);
  };
  visit(document);
  return files
    .filter((file) => sources.has(file.src))
    .map(({ path, base64 }) => ({ path, base64 }));
}

/** Committed images by `src`, pointed at the studio: the site's own URL means nothing on this origin. */
export function committedPreviews(
  siteId: string,
  config: CmsConfig,
  document: unknown,
): Record<string, string> {
  const prefix = `${config.mediaUrlPrefix.replace(/\/+$/, "")}/`;
  const previews: Record<string, string> = {};
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const src = (value as { src?: unknown }).src;
    if (
      typeof src === "string" &&
      src.startsWith(prefix) &&
      !src.slice(prefix.length).includes("/")
    ) {
      previews[src] =
        `/sites/${encodeURIComponent(siteId)}/media/${encodeURIComponent(src.slice(prefix.length))}`;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(document);
  return previews;
}

export function pendingPreviews(
  siteId: string,
  scope: string,
  token: string,
  files: UploadResult[],
): Record<string, string> {
  return token
    ? Object.fromEntries(
        files.map((file, index) => [
          file.src,
          `/sites/${encodeURIComponent(siteId)}/pending-media/${encodeURIComponent(token)}/${index}?scope=${encodeURIComponent(scope)}`,
        ]),
      )
    : {};
}
