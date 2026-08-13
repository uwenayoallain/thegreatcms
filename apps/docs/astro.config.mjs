import { greatcmsWatch } from "@greatcms/reader/vite";
import { defineConfig } from "astro/config";

// Nothing CMS-specific in the build: managed content is read with a plain
// function call. The one dev-time addition is a watcher — the reader uses `fs`,
// so Vite would not otherwise know that editing content should reload the page.
export default defineConfig({
  site: "https://greatcms.dev",
  build: { format: "directory" },
  vite: { plugins: [greatcmsWatch({ root: new URL(".", import.meta.url).pathname })] },
});
