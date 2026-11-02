/** Registered by the Nuxt module in development only: adds the preview script to each page. */

import { PREVIEW_CHROME } from "./vite.js";

interface NitroLike {
  hooks: { hook(name: "render:html", handler: (html: { head: string[] }) => void): void };
}

export default function greatcmsPreview(nitro: NitroLike): void {
  nitro.hooks.hook("render:html", (html) => {
    html.head.push(PREVIEW_CHROME);
  });
}
