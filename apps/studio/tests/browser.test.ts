/** The studio in a real browser. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createSessionCookie } from "../src/auth.js";
import { Store } from "../src/db.js";

const require = createRequire(import.meta.url);
const AXE = require.resolve("axe-core/axe.min.js");
const SECRET = "browser-test-secret";

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
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true, label: Heading }
      body: { type: richtext, label: Body }
    default:
      heading: Welcome
`;

let context: BrowserContext;
let server: ReturnType<typeof serve>;
let origin: string;
let root: string;

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
  const app = createApp({ store, password: "not-used-here", secret: SECRET });
  server = serve({ fetch: app.fetch, port: 0, createServer });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  store.addSite({
    id: "site-1",
    name: "On disk",
    kind: "local",
    path: root,
    // The frame needs somewhere real to point; the studio itself will do, since what.
    devUrl: origin,
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
  const [name, value] = createSessionCookie(SECRET).split(";")[0]!.split("=") as [string, string];
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
  }, 20_000);

  it("says so in the status line, next to the site itself", async () => {
    const page = await editor();

    await page.locator("#f-heading").fill("Another edit");
    await expect
      .poll(() => page.locator("#live-status").textContent(), { timeout: 5000 })
      .toContain("showing this edit");

    expect(await page.locator("iframe[data-live-site]").count()).toBe(1);
  }, 20_000);

  it("throws the edit away again, and offers a manual reload", async () => {
    const page = await editor();

    await page.locator("#f-heading").fill("Changed my mind");
    await expect.poll(() => existsSync(draftFile()), { timeout: 5000 }).toBe(true);

    // The reload button is hidden until JavaScript can drive it.
    await expect.poll(() => page.locator("[data-live-reload]").isVisible()).toBe(true);

    await page.getByRole("button", { name: "Discard unsaved edits" }).click();
    await page.waitForLoadState("networkidle");

    expect(existsSync(draftFile())).toBe(false);
  }, 20_000);

  it("keeps the discard button working with JavaScript switched off", async () => {
    await (await editor()).locator("#f-heading").fill("Written, then dropped");
    await expect.poll(() => existsSync(draftFile()), { timeout: 5000 }).toBe(true);

    const page = await editor({ js: false });
    expect(await page.locator("[data-live-reload]").isVisible()).toBe(false);

    await page.getByRole("button", { name: "Discard unsaved edits" }).click();
    await page.waitForLoadState("networkidle");

    expect(existsSync(draftFile())).toBe(false);
  }, 20_000);
});

describe.skipIf(!browser)("accessibility with real layout", () => {
  it.each([
    ["the site list", "/"],
    ["a site", "/sites/site-1"],
    ["the editor", "/sites/site-1/regions/home.hero"],
  ])("%s has no axe violations, colour contrast included", async (_name, path) => {
    const page = await open(path);
    await page.addScriptTag({ path: AXE });

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
});
