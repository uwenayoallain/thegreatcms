/** The studio's live preview for Nuxt, as a module: `modules: ["@greatcms/reader/nuxt"]`. */

import { fileURLToPath } from "node:url";
import { greatcmsWatch, type WatchOptions } from "./vite.js";

/** The slice of Nuxt this module touches, so it needs no dependency on `@nuxt/kit`. */
interface NuxtLike {
  options: {
    dev: boolean;
    rootDir: string;
    vite: { plugins?: unknown[] };
    nitro: { plugins?: string[] };
    devtools?: boolean | { enabled?: boolean };
  };
}

/**
 * In `nuxt dev` only: the content watcher for Vite, and a Nitro plugin that adds
 * the preview script to each rendered page. A generated site carries none of it.
 */
export function greatcmsNuxt(options: WatchOptions = {}, nuxt?: NuxtLike): void {
  if (!nuxt?.options.dev) return;
  // A preview server is only seen inside the studio, so DevTools would be loaded for nobody.
  if (process.env.GREATCMS_PREVIEW_SERVER === "1") nuxt.options.devtools = { enabled: false };
  nuxt.options.vite.plugins = [
    ...(nuxt.options.vite.plugins ?? []),
    // Nuxt renders its own HTML; the Nitro plugin adds the script instead.
    greatcmsWatch({ root: nuxt.options.rootDir, ...options, hideDevOverlays: false }),
  ];
  if (options.hideDevOverlays === false) return;
  nuxt.options.nitro.plugins = [
    ...(nuxt.options.nitro.plugins ?? []),
    fileURLToPath(new URL("./nuxt-nitro.js", import.meta.url)),
  ];
}

greatcmsNuxt.meta = { name: "@greatcms/reader", configKey: "greatcms" };

export default greatcmsNuxt;
