import { defineConfig } from "astro/config";

// Nothing CMS-specific here. That is the point: managed content is read with a
// plain function call at build time, so there is no integration to install, no
// build hook to keep in sync, and nothing to remove if the CMS goes away.
export default defineConfig({
  site: "https://example.com",
  build: { format: "directory" },
});
