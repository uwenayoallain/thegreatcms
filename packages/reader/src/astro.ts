/** An Astro integration for the studio's live preview. */

import { greatcmsWatch, PREVIEW_SCRIPT, type WatchOptions } from "./vite.js";

interface AstroIntegration {
  name: string;
  hooks: {
    "astro:config:setup": (options: {
      command: "dev" | "build" | "preview" | "sync";
      updateConfig: (config: { vite: { plugins: unknown[] } }) => unknown;
      injectScript: (stage: "page", content: string) => void;
    }) => void;
  };
}

export interface GreatcmsOptions extends WatchOptions {}

/**
 * Wires a site up for the studio: the dev-time content watcher, and the small
 * script that hides Astro's dev toolbar while the page is being previewed
 * inside the studio.
 *
 * Astro renders its own HTML and never calls Vite's `transformIndexHtml`, so
 * the Vite plugin alone cannot reach the page — `injectScript` is the supported
 * way in, and it is only called for `dev`, so a built page carries none of it.
 *
 *     import greatcms from "@greatcms/reader/astro";
 *     export default defineConfig({ integrations: [greatcms()] });
 */
export function greatcms(options: GreatcmsOptions = {}): AstroIntegration {
  return {
    name: "@greatcms/reader",
    hooks: {
      "astro:config:setup": ({ command, updateConfig, injectScript }) => {
        if (command !== "dev") return;

        updateConfig({ vite: { plugins: [greatcmsWatch(options)] } });
        if (options.hideDevOverlays !== false) injectScript("page", PREVIEW_SCRIPT);
      },
    },
  };
}

export default greatcms;
