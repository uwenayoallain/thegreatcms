/** Layout stability, in a browser: the shared frame sits in one place on every page, and nothing moves once it is drawn. */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, relative } from "node:path";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIST = join(new URL("..", import.meta.url).pathname, "dist");
const WIDTHS = [375, 768, 1024, 1280, 1600];
const LANDMARKS = {
  header: ".site-header",
  nav: ".site-header nav",
  main: "main",
  footer: ".site-footer",
};
// Which edges must match between pages: the footer's top follows the content above it.
const COMPARED = { header: "xywh", nav: "xywh", main: "xyw", footer: "xwh" } as const;
// Long enough that a font with a swap period would land after the first paint and reflow it.
const LATE_FONT_MS = 400;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};

// Visible scrollbars, as on most desktops, so a page that gains one is caught moving sideways.
const ARGS = { ignoreDefaultArgs: ["--hide-scrollbars"] };

async function launch(): Promise<Browser | null> {
  const { chromium } = await import("playwright");
  return chromium
    .launch(ARGS)
    .catch(() => chromium.launch({ ...ARGS, channel: "chromium" }))
    .catch(() => chromium.launch({ ...ARGS, channel: "chrome" }))
    .catch(() => {
      console.warn(
        "No Chromium available: layout tests skipped. `pnpm exec playwright install chromium`.",
      );
      return null;
    });
}

const browser = await launch();

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );

const pages = () =>
  walk(DIST)
    .filter((file) => file.endsWith(".html"))
    .map((file) => `/${relative(DIST, file).replace(/index\.html$/, "")}`)
    .toSorted();

/** A static server for the build; `fontDelay` holds every font back, as a slow connection would. */
function serveDist(fontDelay = 0): Server {
  return createServer((request, response) => {
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
    const send = () => {
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      });
      createReadStream(file).pipe(response);
    };
    if (extname(file) === ".woff2") setTimeout(send, fontDelay);
    else send();
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type Measure = { shift: number; boxes: Record<string, number[] | null> };

let fast: Server;
let slow: Server;
let origin: string;
let slowOrigin: string;

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("Run `pnpm build` in examples/studio-astro before the layout tests.");
  }
  if (!browser) return;
  fast = serveDist();
  slow = serveDist(LATE_FONT_MS);
  [origin, slowOrigin] = await Promise.all([listen(fast), listen(slow)]);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  fast?.close();
  slow?.close();
});

/** Loads a page, measures the landmarks, then scrolls to the end; every layout shift on the way is summed. */
async function measure(url: string, width: number): Promise<Measure> {
  const context = await browser!.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const record = globalThis as unknown as { shift: number };
    record.shift = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as { value: number }[])
        record.shift += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  try {
    await page.goto(url, { waitUntil: "load" });
    return await page.evaluate(async (landmarks) => {
      // oxlint-disable-next-line consistent-function-scoping -- this body runs in the page, which sees nothing outside it
      const frames = () =>
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await document.fonts.ready;
      await frames();
      const boxes = Object.fromEntries(
        Object.entries(landmarks).map(([name, selector]) => {
          const box = document.querySelector(selector)?.getBoundingClientRect();
          return [name, box ? [box.x, box.y + scrollY, box.width, box.height] : null];
        }),
      );
      for (let y = 0; y <= document.documentElement.scrollHeight; y += innerHeight) {
        scrollTo(0, y);
        // oxlint-disable-next-line no-await-in-loop -- a scroll is one screen after another
        await frames();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { boxes, shift: (globalThis as unknown as { shift: number }).shift };
    }, LANDMARKS);
  } finally {
    await context.close();
  }
}

describe.skipIf(!browser)("layout", () => {
  it.concurrent.each(WIDTHS)(
    "at %ipx, every page puts the header, nav, main column and footer in the same place, and nothing shifts, even when the font is late",
    async (width) => {
      const paths = pages();
      const [results, late] = await Promise.all(
        [origin, slowOrigin].map(
          async (from) =>
            new Map(
              await Promise.all(
                paths.map(async (path) => [path, await measure(from + path, width)] as const),
              ),
            ),
        ),
      );
      const home = results!.get("/")!;

      for (const [path, { shift, boxes }] of results!) {
        expect(shift, `${path} at ${width}px shifted`).toBe(0);
        expect(late!.get(path)!.shift, `${path} at ${width}px shifted when its font was late`).toBe(
          0,
        );
        for (const [name, edges] of Object.entries(COMPARED)) {
          const box = boxes[name];
          expect(box, `${path} has no ${name}`).toBeTruthy();
          for (const edge of edges) {
            const at = "xywh".indexOf(edge);
            // A pixel is the most text rounding differs by between machines' font renderers.
            expect(
              Math.abs(box![at]! - home.boxes[name]![at]!),
              `${path} ${name}.${edge} at ${width}px`,
            ).toBeLessThanOrEqual(1);
          }
        }
      }
    },
    120_000,
  );
});
