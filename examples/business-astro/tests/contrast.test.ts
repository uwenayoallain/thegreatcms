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
  ["products", "/products/"],
  ["product detail", "/products/climbing-bean-seed/"],
  ["contact", "/contact/"],
  ["privacy policy", "/privacy-policy/"],
  ["terms of service", "/terms-of-service/"],
] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function launch(): Promise<Browser | null> {
  const { chromium } = await import("playwright");
  return chromium
    .launch()
    .catch(() => chromium.launch({ channel: "chrome" }))
    .catch(() => {
      console.warn("No Chromium available: contrast tests skipped.");
      return null;
    });
}

const browser = await launch();

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
    throw new Error("Run `pnpm build` in examples/business-astro before the tests.");
  }
  if (!browser) return;
  server = serveDist();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe.skipIf(!browser).each(PAGES)("%s", (_name, path) => {
  it("has readable contrast against its real background", async () => {
    const page = await browser!.newPage();
    try {
      // No script runs on these pages, so `load` means the layout is final; `networkidle` only adds a wait.
      await page.goto(origin + path, { waitUntil: "load" });
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
        return results.violations.flatMap((violation) => violation.nodes.map((node) => node.html));
      });
      expect(violations).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
