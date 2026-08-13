import { defineConfig } from "astro/config";

// The docs site is managed by GreatCMS itself, and reads its content the same
// way any other site does: a function call at build time, no integration.
export default defineConfig({
  site: "https://greatcms.dev",
  build: { format: "directory" },
});
