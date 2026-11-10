/** Compiled by `pnpm typecheck`, never run: the reader's Nuxt module against Nuxt's own types. */

import greatcmsNuxt from "@greatcms/reader/nuxt";
import { defineNuxtConfig } from "nuxt/config";
import type { NuxtModule } from "nuxt/schema";

export const asModule: NuxtModule = greatcmsNuxt;

export default defineNuxtConfig({
  modules: [
    "@greatcms/reader/nuxt",
    greatcmsNuxt,
    ["@greatcms/reader/nuxt", { hideDevOverlays: false }],
    [greatcmsNuxt, { include: ["data"] }],
  ],
});
