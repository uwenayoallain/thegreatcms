/** Request plumbing: bounded bodies, safe redirects, and the shape of submitted forms. */

import { stat } from "node:fs/promises";

export const DEV_URL_ERROR = "Use an address that starts with http:// or https://.";

export async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/** A URL a browser will fetch, rather than one it will execute. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Only same-site paths: an open redirect would make this a phishing tool. */
export function isSafeRedirect(target: string): boolean {
  // Browsers read `/\host` and `/<tab>/host` as `//host`, so the raw string is not enough.
  if (!target.startsWith("/") || [...target].some(isUnsafeInPath)) return false;
  const base = "http://studio.invalid";
  try {
    return new URL(target, base).origin === base;
  } catch {
    return false;
  }
}

/** A body read up to `limit` bytes, or null past it, whatever content-length claimed. */
export async function readLimited(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early cancels the stream, so an oversized body stops being read.
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export function isUnsafeInPath(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return character === "\\" || code < 0x20 || code === 0x7f;
}

/**
 * The site a visitor submitted from. Redirecting there is not an open redirect: the
 * visitor was already on that page, and only the page itself chose to post here.
 */
export function submittingOrigin(request: Request): string | null {
  for (const value of [request.headers.get("origin"), request.headers.get("referer")]) {
    if (!value || value === "null") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // Not a URL, so not an origin to trust.
    }
  }
  return null;
}

export function submissionId(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

/** Form fields as string pairs; uploads are not part of an unsaved draft. */
export async function formEntries(request: Request): Promise<Array<[string, string]>> {
  const form = await request.formData();
  return [...form.entries()].map(
    ([key, value]) => [key, typeof value === "string" ? value : ""] as [string, string],
  );
}
