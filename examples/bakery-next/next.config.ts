import type { NextConfig } from "next";

const config: NextConfig = {
  // Every page is HTML on disk: a static host, or greatcms-deploy, serves the folder as it is.
  output: "export",
  distDir: "dist",
  trailingSlash: true,
  images: { unoptimized: true },
  // The repository is a pnpm workspace; this site is one folder of it.
  turbopack: { root: new URL("../..", import.meta.url).pathname },
  // The studio frames this page; its own overlay would sit on top of what is being edited.
  devIndicators: false,
  // Behind the self-hosted preview proxy the page is loaded from a public name, which `next dev`
  // otherwise refuses its scripts and live reload to.
  allowedDevOrigins: process.env.PREVIEW_HOST ? [process.env.PREVIEW_HOST] : [],
  // The repository's own AGENTS.md covers this folder; `next dev` would otherwise write one here.
  agentRules: false,
};

export default config;
