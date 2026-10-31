/** The stylesheet and client bundles, each addressed by a hash of its content so browsers can keep them. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { STYLESHEET } from "./views/layout.js";

export interface Asset {
  body: string | Uint8Array<ArrayBuffer>;
  version: string;
  type: string;
}

const CLIENT_BUNDLES = new Set(["editor.js", "live.js", "form.js", "shell.js"]);
/** The tab icons, served at the root because that is where browsers look without being told. */
export const ICONS: Record<string, string> = {
  "favicon.ico": "image/x-icon",
  "favicon.svg": "image/svg+xml",
  "apple-touch-icon.png": "image/png",
};
/** Display type, the website's own, self-hosted so the studio needs nothing from another origin. */
const FONTS = new Set(["space-grotesk-500.woff2", "space-grotesk-700.woff2"]);
const cache = new Map<string, Asset | null>();

const hash = (content: string | Uint8Array<ArrayBuffer>) =>
  createHash("sha256").update(content).digest("hex").slice(0, 12);

/** Resolved next to the built server bundle, and beside the source in dev. */
function readBundle(file: string): string | null {
  const bytes = readPublic(file);
  return bytes === null ? null : bytes.toString("utf8");
}

function readPublic(file: string): Buffer | null {
  for (const candidate of [`../public/${file}`, `./public/${file}`]) {
    try {
      return readFileSync(new URL(candidate, import.meta.url));
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/** An icon's bytes and type, or null when the file is not there. */
export function icon(file: string): { body: Buffer; type: string } | null {
  const type = ICONS[file];
  if (!type) return null;
  const body = readPublic(file);
  return body === null ? null : { body, type };
}

export function asset(file: string): Asset | null {
  if (file === "studio.css") {
    return { body: STYLESHEET, version: hash(STYLESHEET), type: "text/css" };
  }
  if (!CLIENT_BUNDLES.has(file) && !FONTS.has(file)) return null;

  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  let found: Asset | null = null;
  if (FONTS.has(file)) {
    const bytes = readPublic(`fonts/${file}`);
    if (bytes) found = { body: new Uint8Array(bytes), version: hash(file), type: "font/woff2" };
  } else {
    const body = readBundle(file);
    if (body !== null) found = { body, version: hash(body), type: "text/javascript" };
  }
  cache.set(file, found);
  return found;
}

/** The URL a page should reference, carrying the version so the response can be immutable. */
export function assetUrl(file: string): string {
  const found = asset(file);
  return found ? `/assets/${file}?v=${found.version}` : `/assets/${file}`;
}
