/** The stylesheet and client bundles, each addressed by a hash of its content so browsers can keep them. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
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
/** Hashed once: every page asks for its URL. */
let stylesheet: Asset | undefined;

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
    stylesheet ??= { body: STYLESHEET, version: hash(STYLESHEET), type: "text/css" };
    return stylesheet;
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

const encoded = new Map<string, { br: Buffer; gzip: Buffer }>();

/**
 * An asset compressed once, at the highest level, in the encoding the browser
 * prefers: the bundles never change while the server runs, so there is no
 * reason to squeeze them again on every request. Null for fonts, which are
 * compressed already, or when the browser takes neither encoding.
 */
export function compressed(
  file: string,
  found: Asset,
  accept: string | undefined,
): { body: Buffer; encoding: "br" | "gzip" } | null {
  if (found.type.startsWith("font/")) return null;
  const accepted = new Map(
    (accept ?? "").split(",").map((part) => {
      const [name = "", ...params] = part.trim().toLowerCase().split(";");
      const q = params.find((param) => param.trim().startsWith("q="));
      return [name.trim(), q ? Number(q.trim().slice(2)) : 1] as const;
    }),
  );
  const wants = (encoding: string) => (accepted.get(encoding) ?? accepted.get("*") ?? 0) > 0;
  const encoding = wants("br") ? "br" : wants("gzip") ? "gzip" : null;
  if (!encoding) return null;
  const key = `${file}@${found.version}`;
  let both = encoded.get(key);
  if (!both) {
    const bytes =
      typeof found.body === "string" ? Buffer.from(found.body) : Buffer.from(found.body);
    both = {
      br: brotliCompressSync(bytes, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
        },
      }),
      gzip: gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION }),
    };
    encoded.set(key, both);
  }
  return { body: both[encoding], encoding };
}
