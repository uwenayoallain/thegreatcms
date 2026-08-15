/** Colour contrast, in a browser. */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const AXE = require.resolve("axe-core/axe.min.js");
const DIST = join(new URL("..", import.meta.url).pathname, "dist");

const PAGES = [
  ["home", "/"],
  ["about", "/about/"],
  ["blog index", "/blog/"],
  ["blog post", "/blog/publish-from-anywhere/"],
  ["thanks", "/thanks/"],
] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

async function launch(): Promise<Browser | null> {
  const { chromium } = await import("playwright");
  return chromium
    .launch()
    .catch(() => chromium.launch({ channel: "chrome" }))
    .catch(() => {
      console.warn(
        "No Chromium available: contrast tests skipped. `pnpm exec playwright install chromium`.",
      );
      return null;
    });
}

const browser = await launch();

/** Enough of a static server to serve a built site. Nothing writes to it. */
function serveDist(): Server {
  return createServer((request, response) => {
    const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0]!));
    if (path.includes("..")) {
      response.writeHead(400).end();
      return;
    }

    const candidate = join(DIST, path);
    const file =
      existsSync(candidate) && statSync(candidate).isDirectory()
        ? join(candidate, "index.html")
        : candidate;

    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
}

let server: Server;
let origin: string;

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in examples/site-astro before the contrast tests.");
  }
  if (!browser) return;

  server = serveDist();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe.skipIf(!browser).each(PAGES)("%s", (_name, path) => {
  it("has readable contrast against its real background", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(origin + path, { waitUntil: "networkidle" });
      await page.addScriptTag({ path: AXE });

      const violations = await page.evaluate(async () => {
        const results = await (
          globalThis as unknown as {
            axe: {
              run: (
                context: unknown,
                options: unknown,
              ) => Promise<{ violations: Array<{ nodes: Array<{ html: string }> }> }>;
            };
          }
        ).axe.run(document.documentElement, {
          resultTypes: ["violations"],
          runOnly: ["color-contrast"],
        });
        return results.violations.flatMap((v) => v.nodes.map((node) => node.html));
      });

      expect(violations).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
