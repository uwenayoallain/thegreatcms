import greatcms from "@greatcms/reader/astro";
import { defineConfig } from "astro/config";

// Nothing CMS-specific ships. The integration is dev-only: it reloads the page
// when content changes — including the unsaved edits the studio writes — and
// hides Astro's dev toolbar while the page is framed by the studio's preview.
export default defineConfig({
  site: "https://example.com",
  build: { format: "directory" },
  integrations: [greatcms({ root: new URL(".", import.meta.url).pathname })],
});
