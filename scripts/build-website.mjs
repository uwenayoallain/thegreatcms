#!/usr/bin/env node
/**
 * Puts the website and every example site into one static folder: the website at the root, each
 * example under /examples/<slug>/. The examples are built as sites of their own domain, so their
 * addresses are rewritten here; then every link on every page is followed, and a link that lands
 * nowhere fails the build. Run `pnpm build` first.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist-website");
const SITE = "https://greatcms.uwe.rw";
const STUDIO = "https://studio.uwe.rw";

/** Each example, the folder it builds, and the address it is built for: the website lists the same ones. */
export const EXAMPLES = JSON.parse(
  readFileSync(join(ROOT, "apps/docs/src/lib/examples.json"), "utf8"),
);

const TEXT = new Set([
  ".html",
  ".xml",
  ".txt",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".webmanifest",
  ".svg",
]);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** One example's file, with its own addresses moved under its path on the website. */
export function rewrite(text, ext, { slug, origin }) {
  const base = `/examples/${slug}`;
  const prefix = (path) => (path.startsWith(`${base}/`) || path === base ? path : `${base}${path}`);
  let next = text
    // Forms post to the studio's inbox, wherever the example thought its studio was.
    .replaceAll(/action="(?:https:\/\/studio\.[a-z0-9.-]+)?\/f\//g, `action="${STUDIO}/f/`)
    // The address the example was built for, in canonical links, share cards and the sitemap.
    .replaceAll(new RegExp(`${escape(origin)}(?=[/"'\\s<)]|$)/?`, "g"), `${SITE}${base}/`);
  if (ext === ".html" || ext === ".svg") {
    next = next
      .replaceAll(
        /\b(href|src|action|poster|content|component-url|renderer-url|before-hydration-url|xlink:href|data-[\w-]+)="\/(?![/\\])([^"]*)"/g,
        (_, name, path) => `${name}="${prefix(`/${path}`)}"`,
      )
      .replaceAll(
        /\b(srcset|imagesrcset)="([^"]*)"/g,
        (_, name, list) => `${name}="${list.replaceAll(/(^|,\s*)\/(?![/\\])/g, `$1${base}/`)}"`,
      );
  }
  if (ext === ".html" || ext === ".css" || ext === ".svg") {
    next = next.replaceAll(/url\((['"]?)\/(?![/\\])/g, `url($1${base}/`);
  }
  if (ext === ".js" || ext === ".mjs") {
    // Bundled scripts name their own chunks from the root.
    next = next.replaceAll(/(["'`])\/(_astro|_nuxt|_app)\//g, `$1${base}/$2/`);
  }
  if (ext === ".txt") next = next.replaceAll(/^(Sitemap:\s*)\//gm, `$1${SITE}${base}/`);
  return next;
}

/** A way back to the website from every example page: fixed, so it moves nothing, and no script. */
export function backLink() {
  return `<a href="/examples/" data-greatcms-back style="all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483647;display:inline-flex;align-items:center;gap:8px;padding:7px 12px 7px 8px;border-radius:999px;background:#0e0f11;color:#f3f3f3;font:500 13px/1.2 system-ui,sans-serif;border:1px solid rgba(255,255,255,.22);box-shadow:0 2px 12px rgba(0,0,0,.25);cursor:pointer;text-decoration:none"><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" style="display:block"><rect width="16" height="16" rx="3.6" fill="#0e0f11"/><path fill="none" stroke="#f3f3f3" stroke-width="2.2" d="M12.3 5.2A5 5 0 1 0 13 8"/><path fill="#1fbf8a" d="M8 6.9h5v2.2H8z"/></svg>A GreatCMS example<span aria-hidden="true" style="all:initial;color:#9aa0a6;font:inherit">· all examples</span></a>`;
}

/**
 * What Cloudflare sends with each file: the security headers the website had behind Caddy, a year's
 * cache for files whose names change with their content, and no indexing of the examples, whose
 * businesses are made up.
 */
export function headers() {
  const forever = "Cache-Control: public, max-age=31536000, immutable";
  return [
    "/*",
    "  Strict-Transport-Security: max-age=31536000",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Cross-Origin-Opener-Policy: same-origin",
    "/_astro/*",
    `  ${forever}`,
    ...EXAMPLES.flatMap(({ slug }) => [
      `/examples/${slug}/*`,
      "  X-Robots-Tag: noindex",
      ...["_astro", "_nuxt", "_app/immutable", "_next/static"]
        .filter((dir) => existsSync(join(OUT, "examples", slug, dir)))
        .flatMap((dir) => [`/examples/${slug}/${dir}/*`, `  ${forever}`]),
    ]),
    "",
  ].join("\n");
}

/** Every same-site address an HTML page points at. */
function targets(html) {
  const found = [];
  for (const match of html.matchAll(/\b(?:href|src|action|poster)="([^"#?]*)[^"]*"/g))
    found.push(match[1]);
  for (const match of html.matchAll(/\b(?:srcset|imagesrcset)="([^"]*)"/g)) {
    for (const part of match[1].split(",")) found.push(part.trim().split(/\s+/)[0]);
  }
  return found.filter((path) => path.startsWith("/") && !path.startsWith("//"));
}

/** Whether the static host serves something at this path. */
function served(path) {
  const file = join(OUT, decodeURIComponent(path));
  if (!file.startsWith(OUT)) return false;
  if (existsSync(file) && statSync(file).isFile()) return true;
  return [join(file, "index.html"), `${file.replace(/\/$/, "")}.html`].some((candidate) =>
    existsSync(candidate),
  );
}

function main() {
  const missing = [
    join(ROOT, "apps/docs/dist"),
    ...EXAMPLES.map(({ dir }) => join(ROOT, dir, "dist")),
  ]
    .filter((dir) => !existsSync(join(dir, "index.html")))
    .map((dir) => relative(ROOT, dir));
  if (missing.length) {
    console.error(`Not built yet: ${missing.join(", ")}\n  fix: run \`pnpm build\` first.`);
    process.exit(1);
  }
  rmSync(OUT, { recursive: true, force: true });
  cpSync(join(ROOT, "apps/docs/dist"), OUT, { recursive: true });

  for (const example of EXAMPLES) {
    const target = join(OUT, "examples", example.slug);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, example.dir, "dist"), target, { recursive: true });
    for (const file of walk(target)) {
      const ext = extname(file);
      if (!TEXT.has(ext)) continue;
      let text = rewrite(readFileSync(file, "utf8"), ext, example);
      if (ext === ".html") text = text.replace(/<\/body>/i, `${backLink()}</body>`);
      writeFileSync(file, text);
    }
  }

  writeFileSync(join(OUT, "_headers"), headers());

  const broken = [];
  const leftovers = [];
  for (const file of walk(OUT).filter((path) => path.endsWith(".html"))) {
    const html = readFileSync(file, "utf8");
    for (const path of targets(html))
      if (!served(path)) broken.push(`${relative(OUT, file)} → ${path}`);
    const page = relative(OUT, file);
    const example = EXAMPLES.find(({ slug }) => page.startsWith(`examples/${slug}/`));
    if (example && html.includes(`${example.origin}/`)) leftovers.push(page);
  }
  if (broken.length || leftovers.length) {
    console.error(
      [
        ...broken.slice(0, 40).map((line) => `broken link: ${line}`),
        ...leftovers.map((page) => `still names its old address: ${page}`),
      ].join("\n"),
    );
    process.exit(1);
  }
  const pages = walk(OUT).filter((path) => path.endsWith(".html")).length;
  console.log(`dist-website: ${pages} pages, ${EXAMPLES.length} examples, every link lands.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
