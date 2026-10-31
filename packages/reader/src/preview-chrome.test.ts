/** The snippet the dev server injects so the studio's preview is just the page. */

import { describe, expect, it } from "vitest";
import { greatcms } from "./astro.js";
import { greatcmsWatch, injectPreviewChrome, PREVIEW_CHROME, PREVIEW_SCRIPT } from "./vite.js";

describe("what it hides", () => {
  it("names the overlays a framework paints over its own pages", () => {
    expect(PREVIEW_SCRIPT).toContain("astro-dev-toolbar");
    expect(PREVIEW_SCRIPT).toContain("nuxt-devtools-anchor");
    expect(PREVIEW_SCRIPT).toContain("display: none !important");
  });

  it("carries the inspector the studio talks to, guarded the same way", () => {
    expect(PREVIEW_SCRIPT).toContain("data-greatcms-field");
    expect(PREVIEW_SCRIPT).toContain("data-greatcms-block");
    // Only the studio that framed the page gets an answer, and only to its own origin.
    expect(PREVIEW_SCRIPT).toContain("event.source !== window.parent");
    expect(PREVIEW_SCRIPT).toContain("studio.postMessage(message, origin)");
  });

  it("does nothing at all unless the page is framed", () => {
    // The whole guard: on your own tab the toolbar is yours to use.
    expect(PREVIEW_SCRIPT).toContain("window.top !== window.self");
  });
});

describe("injecting it into HTML", () => {
  it("goes last in the head, after the page's own tags", () => {
    const html = "<html><head><title>x</title></head><body>y</body></html>";
    const out = injectPreviewChrome(html);

    expect(out.indexOf("<title>")).toBeLessThan(out.indexOf("data-greatcms-preview"));
    expect(out.indexOf("data-greatcms-preview")).toBeLessThan(out.indexOf("</head>"));
  });

  it("still lands when there is no head to speak of", () => {
    expect(injectPreviewChrome("<p>bare</p>")).toContain("data-greatcms-preview");
  });

  it("does not stack up over repeated transforms", () => {
    const once = injectPreviewChrome("<html><head></head></html>");
    expect(injectPreviewChrome(once)).toBe(once);
  });

  it("is what the Vite plugin transforms with", () => {
    const plugin = greatcmsWatch();
    expect(plugin.transformIndexHtml?.("<head></head>")).toContain(PREVIEW_CHROME);
  });

  it("can be turned off, leaving no HTML hook for a framework to warn about", () => {
    const plugin = greatcmsWatch({ hideDevOverlays: false });
    expect(plugin.transformIndexHtml).toBeUndefined();
  });
});

/** What the integration contributes for a given command. */
function setup(command: "dev" | "build") {
  const scripts: string[] = [];
  const plugins: unknown[] = [];
  greatcms().hooks["astro:config:setup"]({
    command,
    injectScript: (_stage, content) => scripts.push(content),
    updateConfig: (config) => plugins.push(...config.vite.plugins),
  });
  return { scripts, plugins };
}

/** Astro renders its own HTML and never calls transformIndexHtml, so it needs the integration. */
describe("the Astro integration", () => {
  it("adds the watcher and the preview script in dev", () => {
    const { scripts, plugins } = setup("dev");

    expect(plugins).toHaveLength(1);
    expect(scripts).toEqual([PREVIEW_SCRIPT]);
  });

  it("adds nothing to a build, so a shipped page carries none of it", () => {
    const { scripts, plugins } = setup("build");

    expect(plugins).toEqual([]);
    expect(scripts).toEqual([]);
  });
});
