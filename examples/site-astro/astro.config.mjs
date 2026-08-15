import { defineConfig } from "astro/config";

// Nothing CMS-specific here.
export default defineConfig({
  site: "https://example.com",
  build: { format: "directory" },
});
