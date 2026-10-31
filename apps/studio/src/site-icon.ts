/** A site's own favicon, found where its framework keeps one, so a site is recognisable at a glance. */

import { LocalRepository } from "./repo.js";

const TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webp: "image/webp",
};

/** Where Astro, Vite and Nuxt (`public/`), SvelteKit (`static/`) and Next (`app/`) keep one, best first. */
const CANDIDATES = [
  "public/favicon.svg",
  "public/icon.svg",
  "static/favicon.svg",
  "app/icon.svg",
  "src/app/icon.svg",
  "public/apple-touch-icon.png",
  "public/favicon.png",
  "public/icon.png",
  "static/favicon.png",
  "app/icon.png",
  "src/app/icon.png",
  "public/favicon.ico",
  "static/favicon.ico",
  "app/favicon.ico",
  "src/app/favicon.ico",
  "favicon.svg",
  "favicon.ico",
];

/** A favicon is small; anything larger is not one, and is not read into memory. */
const MAX_BYTES = 256 * 1024;

export interface SiteIcon {
  type: string;
  bytes: Uint8Array;
}

export async function findSiteIcon(root: string): Promise<SiteIcon | null> {
  const repo = new LocalRepository(root);
  for (const path of CANDIDATES) {
    // oxlint-disable-next-line no-await-in-loop -- the first one found wins, so the order is the point
    const bytes = await repo.getBytes(path);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) continue;
    const type = TYPES[path.slice(path.lastIndexOf(".") + 1)] as string;
    if (looksLike(type, bytes)) return { type, bytes };
  }
  return null;
}

/** The bytes must be what the name says: a file named .png that is HTML is not served as anything. */
function looksLike(type: string, bytes: Uint8Array): boolean {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (type === "image/png") return starts(0x89, 0x50, 0x4e, 0x47);
  if (type === "image/x-icon") return starts(0x00, 0x00, 0x01, 0x00);
  if (type === "image/webp") return starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57;
  const text = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart().toLowerCase();
  return text.startsWith("<svg") || text.startsWith("<?xml");
}
