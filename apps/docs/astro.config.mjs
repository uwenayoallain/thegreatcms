import greatcms from "@greatcms/reader/astro";
import { defineConfig } from "astro/config";

// Behind the self-hosted preview proxy the dev server answers to a public name; Vite only serves hosts it knows.
const previewHost = process.env.PREVIEW_HOST;

// Nothing CMS-specific in the build: managed content is read with a plain function call. The
// integration is dev-only: it reloads on content changes and lets the studio point into the page.
export default defineConfig({
  site: "https://greatcms.uwe.rw",
  build: { format: "directory" },
  integrations: [greatcms({ root: new URL(".", import.meta.url).pathname })],
  vite: {
    server: { allowedHosts: previewHost ? [previewHost] : undefined },
    // Real targets: with none, Lightning CSS folds animation-timeline into the animation shorthand,
    // which browsers drop whole.
    build: { cssTarget: ["chrome111", "edge111", "firefox114", "safari16.4"] },
    // Lightning CSS's LightDark flag: no light-dark() is written here, so its fallback variables are dead weight.
    css: { lightningcss: { exclude: 1048576 } },
  },
});
