/** Layout in a browser: no page of the website makes a phone scroll sideways. */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, relative } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIST = join(new URL("..", import.meta.url).pathname, "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Every built page, as the address a visitor opens. */
function pages(dir = DIST): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name === "index.html" ? [`/${relative(DIST, dir)}/`.replace("//", "/")] : [];
  });
}

async function launch(): Promise<Browser | null> {
  const { chromium } = await import("playwright");
  return chromium
    .launch()
    .catch(() => chromium.launch({ channel: "chrome" }))
    .catch(() => {
      console.warn(
        "No Chromium available: layout tests skipped. `pnpm exec playwright install chromium`.",
      );
      return null;
    });
}

const browser = await launch();
let server: Server;
let origin: string;

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in apps/docs before the layout tests.");
  }
  if (!browser) return;
  server = createServer((request, response) => {
    const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0]!));
    const candidate = join(DIST, path);
    const file =
      existsSync(candidate) && statSync(candidate).isDirectory()
        ? join(candidate, "index.html")
        : candidate;
    if (path.includes("..") || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe.skipIf(!browser)("on a phone", () => {
  it.each(pages())("%s fits the screen", async (path) => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(origin + path, { waitUntil: "load" });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBe(0);
    } finally {
      await page.close();
    }
  });
});
