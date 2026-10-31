/** The studio's preview script, added to each page under `nuxt dev` only: a generated page carries none of it. */

import { PREVIEW_CHROME } from "@greatcms/reader/vite";

export default defineNitroPlugin((nitro) => {
  if (!import.meta.dev) return;
  nitro.hooks.hook("render:html", (html) => {
    html.head.push(PREVIEW_CHROME);
  });
});
