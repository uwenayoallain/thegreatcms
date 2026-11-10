import { greatcmsWatch } from "@greatcms/reader/sveltekit";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// Behind the self-hosted preview proxy the dev server answers to a public name; Vite only serves hosts it knows.
const previewHost = process.env.PREVIEW_HOST;

export default defineConfig({
  plugins: [
    // Every page is prerendered to HTML; `csr = false` in the root layout keeps them script-free.
    sveltekit({
      adapter: adapter({ pages: "dist", assets: "dist" }),
      prerender: {
        handleHttpError: "fail",
        // A journal with no essays yet has no essay page to render; any other unseen route is a mistake.
        handleUnseenRoutes: ({ routes, message }) => {
          if (routes.some((route) => route !== "/essays/[slug]")) throw new Error(message);
        },
      },
      // Canonical links and share cards are built on the address the site is published at.
      paths: { origin: process.env.SITE_URL ?? "https://thelonglight.example" },
    }),
    // Reloads the page when content changes, the studio's unsaved drafts included. Dev only.
    // `hooks.server.js` adds the preview script, since SvelteKit renders its own HTML.
    greatcmsWatch({ root: new URL(".", import.meta.url).pathname }),
  ],
  server: { allowedHosts: previewHost ? [previewHost] : undefined },
  // Loaded by Node rather than transformed by Vite, so rebuilding the reader in the workspace
  // cannot catch a running dev server between files and leave every page an error.
  ssr: { external: ["@greatcms/reader"] },
  // Real targets for Lightning CSS, which otherwise folds declarations some browsers then drop.
  build: { cssTarget: ["chrome111", "edge111", "firefox114", "safari16.4"] },
});
