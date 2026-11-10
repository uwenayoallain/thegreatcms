import { renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export default defineNuxtConfig({
  // Under `nuxt dev` only: content edits reload the page, and the studio's preview works.
  modules: ["@greatcms/reader/nuxt"],
  compatibilityDate: "2026-10-01",
  devtools: { enabled: false },
  telemetry: false,
  css: ["~/assets/site.css"],
  // Where the waitlist form posts: the studio's inbox, set at build time.
  runtimeConfig: {
    public: {
      cmsUrl: process.env.PUBLIC_CMS_URL ?? "",
      cmsSite: process.env.PUBLIC_CMS_SITE_ID ?? "sundial",
      // The address the site is published at: canonical links, the sitemap and share cards are built on it.
      siteUrl: process.env.SITE_URL ?? "https://sundial.example",
    },
  },
  app: {
    head: {
      htmlAttrs: { lang: "en" },
      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    },
  },
  vite: {
    // Behind the self-hosted preview proxy the dev server answers to a public name; Vite only serves hosts it knows.
    server: { allowedHosts: process.env.PREVIEW_HOST ? [process.env.PREVIEW_HOST] : undefined },
  },
  nitro: {
    // Written where the rest of the repository's builds go, and what greatcms-deploy serves.
    output: { publicDir: "dist" },
    prerender: {
      crawlLinks: true,
      failOnError: true,
      routes: ["/404", "/sitemap.xml", "/robots.txt"],
    },
    hooks: {
      close: () => {
        // Nuxt's built-in 404.html is the unrendered SPA shell; replace it with the prerendered 404 page.
        renameSync(resolve("dist/404/index.html"), resolve("dist/404.html"));
        rmSync(resolve("dist/404"), { recursive: true, force: true });
        rmSync(resolve("dist/200.html"), { force: true });
      },
    },
  },
  // Every page is complete HTML, so a generated page needs no JavaScript at all. Development keeps
  // its client, which is what reloads the page when content changes.
  $production: { routeRules: { "/**": { noScripts: true } } },
});
