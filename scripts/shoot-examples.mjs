#!/usr/bin/env node
/**
 * Screenshots each example's home page, light and dark, for the website's examples page.
 * Run after `node scripts/build-website.mjs`; the images are committed, so only when a site changes.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist-website");
const SHOTS = join(ROOT, "apps/docs/src/assets/examples");
const EXAMPLES = JSON.parse(readFileSync(join(ROOT, "apps/docs/src/lib/examples.json"), "utf8"));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
  let file = join(OUT, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!file.startsWith(OUT) || !existsSync(file)) return void response.writeHead(404).end();
  response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const { chromium } = createRequire(join(ROOT, "apps/studio/package.json"))("playwright");
const browser = await chromium
  .launch()
  .catch(() => chromium.launch({ channel: "chromium" }))
  .catch(() => chromium.launch({ channel: "chrome" }));
mkdirSync(SHOTS, { recursive: true });
try {
  const shots = EXAMPLES.flatMap(({ slug }) =>
    ["light", "dark"].map((scheme) => ({
      slug,
      scheme,
      file: scheme === "dark" ? `${slug}-dark` : slug,
    })),
  );
  await Promise.all(
    shots.map(async ({ slug, scheme, file }) => {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        colorScheme: scheme,
      });
      await page.goto(`${origin}/examples/${slug}/`, { waitUntil: "load" });
      await page.evaluate(async () => {
        document.querySelector("[data-greatcms-back]")?.remove();
        await document.fonts.ready;
      });
      // Entrance motion settles first, so the picture is the page as a visitor sees it.
      await page.waitForTimeout(1800);
      await page.screenshot({ path: join(SHOTS, `${file}.png`) });
      await page.close();
      console.log(`examples/${slug} (${scheme})`);
    }),
  );
} finally {
  await browser.close();
  server.close();
}
