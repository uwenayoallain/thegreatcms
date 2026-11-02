/** The one-line integrations for Next.js, Nuxt and SvelteKit: present in development, absent from a build. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { GreatcmsPreview } from "./next.js";
import greatcmsPreviewPlugin from "./nuxt-nitro.js";
import { greatcmsNuxt } from "./nuxt.js";
import { greatcmsHandle, greatcmsWatch } from "./sveltekit.js";
import { PREVIEW_CHROME, PREVIEW_SCRIPT } from "./vite.js";

afterEach(() => vi.unstubAllEnvs());

describe("Next.js", () => {
  it("renders the preview script in development, marked as not watching content", () => {
    vi.stubEnv("NODE_ENV", "development");
    const element = GreatcmsPreview() as ReactElement<{
      dangerouslySetInnerHTML: { __html: string };
      type: string;
    }>;
    expect(isValidElement(element)).toBe(true);
    expect(element.type).toBe("script");
    expect(element.props.type).toBe("module");
    const { __html: source } = element.props.dangerouslySetInnerHTML; // oxlint-disable-line no-underscore-dangle -- React's own name
    expect(source.startsWith("window.__greatcmsUnwatched = true;")).toBe(true);
    expect(source).toContain(PREVIEW_SCRIPT);
  });

  it("renders nothing in a build", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(GreatcmsPreview()).toBeNull();
  });
});

function nuxt(dev: boolean) {
  return {
    options: {
      dev,
      rootDir: "/site",
      vite: { plugins: [{ name: "theirs" }] as unknown[] },
      nitro: {} as { plugins?: string[] },
    },
  };
}

describe("Nuxt", () => {
  it("adds the watcher and the Nitro plugin under nuxt dev, keeping the site's own plugins", () => {
    const app = nuxt(true);
    greatcmsNuxt({}, app);
    expect(app.options.vite.plugins).toHaveLength(2);
    expect(app.options.vite.plugins[0]).toEqual({ name: "theirs" });
    expect(app.options.nitro.plugins?.[0]).toMatch(/nuxt-nitro\.js$/);
  });

  it("adds nothing to a generated site", () => {
    const app = nuxt(false);
    greatcmsNuxt({}, app);
    expect(app.options.vite.plugins).toHaveLength(1);
    expect(app.options.nitro.plugins).toBeUndefined();
  });

  it("puts the script in each rendered page's head", () => {
    let render: ((html: { head: string[] }) => void) | undefined;
    greatcmsPreviewPlugin({ hooks: { hook: (_name, handler) => (render = handler) } });
    const html = { head: ["<title>x</title>"] };
    render?.(html);
    expect(html.head).toEqual(["<title>x</title>", PREVIEW_CHROME]);
  });
});

/** Runs the handle over a page delivered in chunks, as SvelteKit streams it. */
async function run(chunks: string[]) {
  let out = "";
  await greatcmsHandle({
    event: {},
    resolve: (_event, options) => {
      chunks.forEach((html, index) => {
        out += options?.transformPageChunk?.({ html, done: index === chunks.length - 1 }) ?? html;
      });
      return new Response(out);
    },
  });
  return out;
}

describe("SvelteKit", () => {
  const page = "<html><head><title>x</title></head><body>y</body></html>";

  it("adds the script once to a page under vite dev, streamed or not", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(await run([page])).toContain("data-greatcms-preview");
    const streamed = await run(["<html><head></head><body>", "a", "b</body></html>"]);
    expect(streamed.match(/data-greatcms-preview/g)).toHaveLength(1);
    expect(streamed.indexOf("data-greatcms-preview")).toBeLessThan(streamed.indexOf("</head>"));
  });

  it("leaves a build alone", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await run([page])).toBe(page);
  });

  it("has no HTML hook for SvelteKit to warn about", () => {
    expect(greatcmsWatch().transformIndexHtml).toBeUndefined();
  });
});

describe("the inspector, as the page sees it", () => {
  it("draws in a shadow root on an inert, hidden element", () => {
    expect(PREVIEW_SCRIPT).toContain('createElement("greatcms-overlay")');
    expect(PREVIEW_SCRIPT).toContain('setAttribute("inert", "")');
    expect(PREVIEW_SCRIPT).toContain('setAttribute("aria-hidden", "true")');
    expect(PREVIEW_SCRIPT).toContain("attachShadow");
  });

  it("never touches <html> until someone turns on Select, so hydration sees the server's markup", () => {
    expect(PREVIEW_SCRIPT).not.toContain("data-greatcms-framed");
    expect(PREVIEW_SCRIPT).not.toMatch(/documentElement\.setAttribute/);
  });

  it("puts its styles back after a client-side navigation swaps the head", () => {
    expect(PREVIEW_SCRIPT.match(/astro:after-swap/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
