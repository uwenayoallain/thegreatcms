/** The studio in a real browser. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Chromium round trips take seconds, and `pnpm check` runs this beside every other package's tests.
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });
import { createApp } from "../src/app.js";
import { createSessionCookie, sessionKey } from "../src/auth.js";
import { Store } from "../src/db.js";
import { PREVIEW_CHROME } from "@greatcms/reader/vite";

const require = createRequire(import.meta.url);
const AXE = require.resolve("axe-core/axe.min.js");
/**
 * Evaluated rather than injected with addScriptTag: the studio serves
 * `script-src 'self'`, which correctly refuses an injected tag. Running the
 * source through CDP tests the page as shipped instead of relaxing its policy
 * for the benefit of the test.
 */
const AXE_SOURCE = readFileSync(AXE, "utf8");
const SECRET = "browser-test-secret";
const PASSWORD = "browser-test-password";

/** Playwright's own browser first; a system Chrome is the fallback. */
async function launch(): Promise<Browser | null> {
  const { chromium } = await import("playwright");
  return chromium
    .launch()
    .catch(() => chromium.launch({ channel: "chrome" }))
    .catch(() => {
      console.warn(
        "No Chromium available: browser tests skipped. `pnpm exec playwright install chromium`.",
      );
      return null;
    });
}

// Resolved at collection time so the suite can report as skipped rather than passing.
const browser = await launch();

const SCHEMA = `version: 1
blocks:
  feature:
    label: Feature
    fields:
      heading: { type: text, required: true }
      image: { type: image }
regions:
  home.sections:
    label: Home sections
    type: blocks
    allow: [feature]
    default:
      - { _type: feature, heading: First feature }
      - { _type: feature, heading: Second feature }
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true, label: Heading }
      body: { type: richtext, label: Body }
    default:
      heading: Welcome
collections:
  pages:
    label: Pages
    entryLabel: page
    path: content/pages
    format: json
    slug: title
    fields:
      title: { type: text, required: true }
      sections: { type: blocks, allow: [feature] }
`;

let context: BrowserContext;
let server: ReturnType<typeof serve>;
let devServer: ReturnType<typeof createServer>;
let origin: string;
let root: string;
const PLAIN_PAGE = "<!doctype html><title>Site</title><h1>Welcome</h1><p>Existing copy.</p>";
/** What the fake dev server serves; a test may swap in a page that runs the inspector. */
let sitePage = PLAIN_PAGE;

const CONTENT = "content/cms/home.hero.json";
const heroFile = () => readFileSync(join(root, CONTENT), "utf8");

beforeAll(async () => {
  if (!browser) return;

  root = mkdtempSync(join(tmpdir(), "greatcms-browser-"));
  mkdirSync(join(root, ".cms"), { recursive: true });
  mkdirSync(join(root, "content/cms"), { recursive: true });
  writeFileSync(join(root, ".cms/schema.yaml"), SCHEMA);
  writeFileSync(join(root, ".cms/config.yaml"), "version: 1\n");
  writeFileSync(
    join(root, CONTENT),
    JSON.stringify({ heading: "Welcome", body: { html: "<p>Existing copy.</p>" } }, null, 2),
  );

  const store = new Store(":memory:");
  const app = createApp({ store, password: PASSWORD, secret: SECRET });
  server = serve({ fetch: app.fetch, port: 0, createServer });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  // The site's own dev server, on another origin: the studio refuses to be framed, rightly.
  devServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(sitePage);
  });
  await new Promise<void>((resolve) => devServer.listen(0, "127.0.0.1", resolve));
  const previewAddress = devServer.address();
  const previewOrigin = `http://127.0.0.1:${typeof previewAddress === "object" && previewAddress ? previewAddress.port : 0}`;

  store.addSite({
    id: "site-1",
    name: "On disk",
    kind: "local",
    path: root,
    devUrl: previewOrigin,
    owner: "",
    repo: "",
    branch: "main",
    token: "",
    publishMode: "direct",
    aiTitles: false,
    createdAt: "2026-08-15",
  });

  context = await newSignedInContext();
}, 60_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  server?.close();
  devServer?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const opened: Array<{ page: Page; own: BrowserContext | null }> = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async ({ page, own }) => {
      await page.close();
      await own?.close();
    }),
  );
});

/** A signed-in browser context: the studio has one password and one cookie. */
async function newSignedInContext(javaScriptEnabled = true): Promise<BrowserContext> {
  const fresh = await browser!.newContext({ javaScriptEnabled });
  const [name, value] = createSessionCookie(sessionKey(SECRET, PASSWORD))
    .split(";")[0]!
    .split("=") as [string, string];
  await fresh.addCookies([{ name, value, url: origin }]);
  return fresh;
}

/** Opens a studio page. `js: false` exercises the no-JavaScript path. */
async function open(path: string, options: { js?: boolean } = {}): Promise<Page> {
  const own = options.js === false ? await newSignedInContext(false) : null;
  const page = await (own ?? context).newPage();
  opened.push({ page, own });
  await page.goto(origin + path, { waitUntil: "networkidle" });
  return page;
}

const editor = (options?: { js?: boolean }) => open("/sites/site-1/regions/home.hero", options);
const surfaceOf = (page: Page) => page.locator(".editor-surface [contenteditable='true']");
const richTextValue = (page: Page) => page.locator("textarea[data-richtext]").inputValue();

describe.skipIf(!browser)("the visual editor", () => {
  it("mounts an editing surface and keeps the textarea that submits", async () => {
    const page = await editor();
    const textarea = page.locator("textarea[data-richtext]");

    await expect.poll(() => surfaceOf(page).isVisible()).toBe(true);
    // Hidden, not replaced: the value that posts is still the textarea's.
    expect(await textarea.count()).toBe(1);
    expect(await textarea.isVisible()).toBe(false);
    expect(await textarea.getAttribute("aria-hidden")).toBe("true");

    // It opens on the stored value rather than empty.
    expect(await surfaceOf(page).textContent()).toContain("Existing copy.");
    expect(await surfaceOf(page).getAttribute("role")).toBe("textbox");
    expect(await surfaceOf(page).getAttribute("aria-label")).toBe("Body");
  });

  it("writes what you type back into the textarea", async () => {
    const page = await editor();

    await surfaceOf(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" And more.");

    const value = await richTextValue(page);
    expect(value).toContain("Existing copy. And more.");
    expect(value.startsWith("<p>")).toBe(true);
  });

  it("applies a mark from the toolbar and reports it as pressed", async () => {
    const page = await editor();
    const bold = page.getByRole("button", { name: "Bold" });

    await surfaceOf(page).click();
    await page.keyboard.press("End");
    await bold.click();
    await page.keyboard.type("loud");

    expect(await richTextValue(page)).toContain("<strong>loud</strong>");
    await expect.poll(() => bold.getAttribute("aria-pressed")).toBe("true");
  });

  it("wraps a paragraph in a list", async () => {
    const page = await editor();

    await surfaceOf(page).click();
    await page.getByRole("button", { name: "Bullet list" }).click();

    const value = await richTextValue(page);
    expect(value).toContain("<ul>");
    expect(value).toContain("<li>");
  });

  it("still edits and publishes when JavaScript never runs", async () => {
    const page = await editor({ js: false });
    const textarea = page.locator("textarea[data-richtext]");

    expect(await textarea.isVisible()).toBe(true);
    expect(await page.locator(".editor-surface").count()).toBe(0);
    expect(await textarea.inputValue()).toContain("Existing copy.");

    await textarea.fill("<p>Written without JavaScript.</p>");
    await page.getByRole("button", { name: "Publish" }).click();
    await page.waitForLoadState("networkidle");

    expect(JSON.parse(heroFile()).body.html).toContain("Written without JavaScript.");
  });

  it("adds a section to a blank new entry without JavaScript or required fields", async () => {
    const page = await open("/sites/site-1/collections/pages/new", { js: false });
    const add = page.getByRole("button", { name: "Add feature" });

    expect(await add.getAttribute("formnovalidate")).not.toBeNull();
    await add.click();
    await page.waitForLoadState("networkidle");

    expect(await page.locator('input[name="f[sections][0][heading]"]').count()).toBe(1);
    expect(existsSync(join(root, "content/pages"))).toBe(false);
  });

  it.each(["region", "collection"])(
    "confirms %s section removal without JavaScript and preserves edits when cancelled",
    async (kind) => {
      const path =
        kind === "region"
          ? "/sites/site-1/regions/home.sections"
          : "/sites/site-1/collections/pages/new";
      const page = await open(path, { js: false });
      await page.setViewportSize({ width: 390, height: 844 });
      if (kind === "collection") {
        await page.getByRole("button", { name: "Add feature" }).click();
        await page.waitForLoadState("networkidle");
        await page.getByRole("button", { name: "Add feature" }).click();
        await page.waitForLoadState("networkidle");
      }
      const blocks = page.locator(".block-collapsible");
      expect(await blocks.count()).toBe(2);
      const first = blocks.first();
      const fields = first.locator(":scope > details");
      if ((await fields.getAttribute("open")) === null)
        await fields.locator(":scope > summary").click();
      await first.locator('input[name$="[heading]"]').fill("Keep my unsaved section text");
      const confirmation = first.locator(".block-remove-confirm");
      expect(await confirmation.count()).toBe(1);
      const confirm = confirmation.getByRole("button", { name: /Confirm remove/ });
      expect(await confirm.isVisible()).toBe(false);
      await confirmation.locator("summary").focus();
      await page.keyboard.press("Enter");
      expect(await confirm.isVisible()).toBe(true);
      expect(await blocks.count()).toBe(2);
      await page.keyboard.press("Enter");
      expect(await confirm.isVisible()).toBe(false);
      expect(await first.locator('input[name$="[heading]"]').inputValue()).toBe(
        "Keep my unsaved section text",
      );
      await confirmation.locator("summary").click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (process.env.GREATCMS_TEST_SCREENSHOTS) {
        await page.screenshot({
          path: join(process.env.GREATCMS_TEST_SCREENSHOTS, `remove-${kind}-mobile.png`),
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      const panel = confirmation.locator(".block-remove-panel");
      const desktopBounds = await panel.boundingBox();
      expect(desktopBounds!.x).toBeGreaterThanOrEqual(0);
      expect(desktopBounds!.x + desktopBounds!.width).toBeLessThanOrEqual(1280);
      if (process.env.GREATCMS_TEST_SCREENSHOTS) {
        await page.screenshot({
          path: join(process.env.GREATCMS_TEST_SCREENSHOTS, `remove-${kind}-desktop.png`),
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 320, height: 720 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await confirm.click();
      await page.waitForLoadState("networkidle");
      expect(await blocks.count()).toBe(1);
      expect(await blocks.first().locator('input[name$="[heading]"]').inputValue()).not.toBe(
        "Keep my unsaved section text",
      );
      expect(existsSync(join(root, "content/pages"))).toBe(false);
      expect(existsSync(join(root, "content/cms/home.sections.json"))).toBe(false);
    },
  );

  it("keeps a selected image through adding another section and publishes without reselecting it", async () => {
    const page = await open("/sites/site-1/collections/pages/new", { js: false });
    await page.locator('input[name="f[title]"]').fill("Image retention");
    await page.getByRole("button", { name: "Add feature" }).click();
    await page.waitForLoadState("networkidle");
    await page.locator('input[name="f[sections][0][heading]"]').fill("With a picture");
    await page.locator('input[name="f[sections][0][image][alt]"]').fill("A one-pixel test image");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
      "base64",
    );
    await page
      .locator('input[name="m[sections][0][image]"]')
      .setInputFiles({ name: "retained.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "Add feature" }).click();
    await page.waitForLoadState("networkidle");
    expect(await page.locator('input[name="pendingMedia"]').inputValue()).toBeTruthy();
    const first = page.locator(".nested-collapsible").first();
    await first.locator(":scope > details > summary").click();
    const preview = first.locator(".preview-thumb img");
    await preview.scrollIntoViewIfNeeded();
    await expect
      .poll(() => preview.evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBe(1);
    expect(await first.locator('input[type="file"]').inputValue()).toBe("");
    await page.locator('input[name="f[sections][1][heading]"]').fill("Another feature");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.waitForLoadState("networkidle");
    const entry = JSON.parse(
      readFileSync(join(root, "content/pages/image-retention.json"), "utf8"),
    );
    expect(entry.sections[0].image.alt).toBe("A one-pixel test image");
    expect(readFileSync(join(root, "public", entry.sections[0].image.src))).toEqual(png);
    expect(await page.locator('input[name="pendingMedia"]').count()).toBe(0);
  });
});

describe.skipIf(!browser)("live editing", () => {
  const draftFile = () => join(root, ".cms/draft", CONTENT);

  it("writes what you type to the draft your dev server reads", async () => {
    const page = await editor();
    const published = heroFile();

    await page.locator("#f-heading").fill("Typed, never saved");

    await expect
      .poll(() => (existsSync(draftFile()) ? readFileSync(draftFile(), "utf8") : ""), {
        timeout: 5000,
      })
      .toContain("Typed, never saved");

    // The published file is untouched: this is a draft, not a publish.
    expect(heroFile()).toBe(published);
  });

  it("says so in the status line, next to the site itself", async () => {
    const page = await editor();

    await page.locator("#f-heading").fill("Another edit");
    await expect
      .poll(() => page.locator("#live-status").textContent(), { timeout: 5000 })
      .toContain("showing this edit");

    expect(await page.locator("iframe[data-live-site]").count()).toBe(1);
  });

  it("throws the edit away again, and offers a manual reload", async () => {
    const page = await editor();

    await page.locator("#f-heading").fill("Changed my mind");
    await expect.poll(() => existsSync(draftFile()), { timeout: 5000 }).toBe(true);

    // The reload button is hidden until JavaScript can drive it.
    await expect.poll(() => page.locator("[data-live-reload]").isVisible()).toBe(true);

    await page.locator("summary", { hasText: "Discard unsaved edits" }).click();
    await page.getByRole("button", { name: "Confirm discard" }).click();
    await page.waitForLoadState("networkidle");

    expect(existsSync(draftFile())).toBe(false);
  });

  it("keeps the discard button working with JavaScript switched off", async () => {
    await (await editor()).locator("#f-heading").fill("Written, then dropped");
    await expect.poll(() => existsSync(draftFile()), { timeout: 5000 }).toBe(true);

    const page = await editor({ js: false });
    expect(await page.locator("[data-live-reload]").isVisible()).toBe(false);

    await page.locator("summary", { hasText: "Discard unsaved edits" }).click();
    await page.getByRole("button", { name: "Confirm discard" }).click();
    await page.waitForLoadState("networkidle");

    expect(existsSync(draftFile())).toBe(false);
  });
});

describe.skipIf(!browser)("pointing at the page", () => {
  it("opens the field the framed page points at, and only one the form holds", async () => {
    const page = await editor();
    await page.waitForSelector("iframe[data-live-site]");
    const framed = page.frames().find((frame) => frame.parentFrame() !== null);
    if (!framed) throw new Error("the preview frame did not load");

    await framed.evaluate(() => {
      window.parent.postMessage({ greatcms: "pick", path: "f[heading]" }, "*");
    });
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 5000 })
      .toBe("f-heading");

    const before = await page.evaluate(() => document.activeElement?.id);
    await framed.evaluate(() => {
      window.parent.postMessage({ greatcms: "pick", path: "f[nothing]" }, "*");
    });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(before);
  });

  it("maps a click to the field whose words are in <main>, not to the nav that repeats them", async () => {
    sitePage = `<!doctype html><title>Site</title>${PREVIEW_CHROME}<nav><a href="/">Welcome</a></nav><main><h1>Welcome</h1><p>Existing copy.</p></main>`;
    try {
      const page = await editor();
      await page.waitForSelector("iframe[data-live-site]");
      await page.locator("label:has(#live-select)").click();
      const framed = page.frames().find((frame) => frame.parentFrame() !== null);
      if (!framed) throw new Error("the preview frame did not load");
      await framed.waitForSelector("main h1");
      await expect
        .poll(() => page.locator("#live-status").innerText(), {
          timeout: 5000,
        })
        .toMatch(/field/);

      await framed.locator("main h1").dispatchEvent("click");
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 5000 })
        .toBe("f-heading");
    } finally {
      sitePage = PLAIN_PAGE;
    }
  });

  it("offers the select and section toggles only once JavaScript can drive them", async () => {
    expect(await (await editor()).locator("#live-select").isVisible()).toBe(true);
    expect(await (await editor({ js: false })).locator("#live-select").isVisible()).toBe(false);
  });
});

describe.skipIf(!browser)("accessibility with real layout", () => {
  it.each([
    ["the site list", "/"],
    ["a site", "/sites/site-1"],
    ["the editor", "/sites/site-1/regions/home.hero"],
    ["section removal confirmation", "/sites/site-1/regions/home.sections"],
    ["publish later", "/sites/site-1/regions/home.hero#schedule"],
    ["history", "/sites/site-1/regions/home.hero/history"],
    ["search results", "/sites/site-1/search?q=e"],
    ["editors", "/editors"],
    ["the inbox", "/inbox"],
    ["sign in", "/sign-in"],
  ])("%s has no axe violations, colour contrast included", async (_name, path) => {
    const page = await open(path.replace("#schedule", ""));
    if (path.endsWith("home.sections"))
      await page.locator(".block-remove-confirm > summary").first().click();
    if (path.endsWith("#schedule")) await page.locator("details.schedule > summary").click();
    await page.evaluate(AXE_SOURCE);

    const violations = await page.evaluate(async () => {
      const results = await (
        globalThis as unknown as {
          axe: {
            run: (
              context: unknown,
              options: unknown,
            ) => Promise<{ violations: Array<{ id: string; nodes: Array<{ html: string }> }> }>;
          };
        }
      ).axe.run(document.documentElement, {
        resultTypes: ["violations"],
        // The preview renders its own document, gated separately; axe cannot reach across the frame.
        exclude: [["iframe"]],
      });
      return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ""}`);
    });

    expect(violations).toEqual([]);
  });

  it("keeps the workspace and every navigation action inside a narrow screen", async () => {
    const page = await context.newPage();
    opened.push({ page, own: null });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + "/sites/site-1", { waitUntil: "networkidle" });

    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(layout.content).toBeLessThanOrEqual(layout.viewport);

    const navigation = page.getByRole("navigation", { name: "Sections" });
    const boxes = await Promise.all([
      navigation.getByRole("link", { name: "Sites" }).boundingBox(),
      navigation.getByRole("link", { name: "Inbox" }).boundingBox(),
      page.getByRole("button", { name: "Sign out" }).boundingBox(),
    ]);
    for (const box of boxes) {
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    }
  });
});
