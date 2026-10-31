/** Working out what a site is built with, so `init` can propose the right. */

/** The frameworks `init` scaffolds for. */
export type FrameworkId = "astro" | "next" | "nuxt" | "sveltekit" | "eleventy" | "generic";

export interface Framework {
  id: FrameworkId;
  label: string;
  /** Where this generator naturally reads data files from. */
  regionsDir: string;
  /** Where prose collections usually live. */
  collectionsDir: string;
  /** Where the site serves static files from. */
  mediaDir: string;
  mediaUrlPrefix: string;
  /** How you read a managed region, shown after scaffolding. */
  snippet(regionId: string, regionsDir: string): string;
}

/** A variable name for a region: the last segment is the part that reads well. */
function nameFor(regionId: string): string {
  const last = regionId.split(".").at(-1) ?? regionId;
  const camel = last.replace(/[-_](.)/g, (_, character: string) => character.toUpperCase());
  return /^[a-z]/.test(camel) ? camel : `region${camel}`;
}

export const FRAMEWORKS: Record<FrameworkId, Framework> = {
  astro: {
    id: "astro",
    label: "Astro",
    regionsDir: "src/content/cms",
    collectionsDir: "src/content/blog",
    mediaDir: "public/media",
    mediaUrlPrefix: "/media",
    snippet: (regionId) =>
      [
        "---",
        'import { createReader } from "@greatcms/reader";',
        "const cms = createReader();",
        `const ${nameFor(regionId)} = cms.region("${regionId}");`,
        "---",
        "",
        `<h1>{${nameFor(regionId)}.heading}</h1>`,
      ].join("\n"),
  },
  next: {
    id: "next",
    label: "Next.js",
    regionsDir: "content/cms",
    collectionsDir: "content/blog",
    mediaDir: "public/media",
    mediaUrlPrefix: "/media",
    snippet: (regionId) =>
      [
        "// app/page.tsx: a server component",
        'import { createReader } from "@greatcms/reader";',
        "",
        "export default function Page() {",
        "  const cms = createReader();",
        `  const ${nameFor(regionId)} = cms.region("${regionId}");`,
        `  return <h1>{${nameFor(regionId)}.heading}</h1>;`,
        "}",
      ].join("\n"),
  },
  nuxt: {
    id: "nuxt",
    label: "Nuxt",
    regionsDir: "content/cms",
    collectionsDir: "content/blog",
    mediaDir: "public/media",
    mediaUrlPrefix: "/media",
    snippet: (regionId) =>
      [
        "<script setup>",
        `const { data: ${nameFor(regionId)} } = await useAsyncData("cms:${regionId}", async () => {`,
        "  if (!import.meta.server) return null;",
        '  const { createReader } = await import("@greatcms/reader");',
        `  return createReader().region("${regionId}");`,
        "});",
        "</script>",
        "",
        `<template><h1>{{ ${nameFor(regionId)}?.heading }}</h1></template>`,
      ].join("\n"),
  },
  sveltekit: {
    id: "sveltekit",
    label: "SvelteKit",
    regionsDir: "src/content/cms",
    collectionsDir: "src/content/blog",
    mediaDir: "static/media",
    mediaUrlPrefix: "/media",
    snippet: (regionId) =>
      [
        "// src/routes/+page.server.ts",
        'import { createReader } from "@greatcms/reader";',
        "export function load() {",
        `  return { ${nameFor(regionId)}: createReader().region("${regionId}") };`,
        "}",
        "",
        "<!-- src/routes/+page.svelte -->",
        '<script lang="ts">',
        `  export let data: { ${nameFor(regionId)}: { heading: string } };`,
        "</script>",
        `<h1>{data.${nameFor(regionId)}.heading}</h1>`,
      ].join("\n"),
  },
  eleventy: {
    id: "eleventy",
    label: "Eleventy",
    // One global data module makes every schema region available to templates.
    regionsDir: "_data/cms",
    collectionsDir: "content/blog",
    mediaDir: "public/media",
    mediaUrlPrefix: "/media",
    snippet: (regionId) =>
      [
        "// _data/cms.mjs",
        'import { createReader } from "@greatcms/reader";',
        "export default function () {",
        "  const cms = createReader();",
        "  return Object.fromEntries(cms.regionIds().map((id) => [id, cms.region(id)]));",
        "}",
        "",
        "<!-- Every schema region is now global data in Eleventy: -->",
        `<h1>{{ cms["${regionId}"].heading }}</h1>`,
      ].join("\n"),
  },
  generic: {
    id: "generic",
    label: "Something else",
    regionsDir: "content/cms",
    collectionsDir: "content/blog",
    mediaDir: "public/media",
    mediaUrlPrefix: "/media",
    snippet: (regionId) =>
      [
        "// JavaScript build or server code:",
        'import { createReader } from "@greatcms/reader";',
        "const cms = createReader();",
        `const ${nameFor(regionId)} = cms.region("${regionId}");`,
        "",
        "// Other languages can implement SPEC.md and verify against @greatcms/conformance.",
      ].join("\n"),
  },
};

export interface DetectionInput {
  /** Paths present at the repository root. */
  files: string[];
  /** Parsed package.json, if there is one. */
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
}

export interface Detection {
  framework: Framework;
  /** What gave it away, shown to the user so detection is never a black box. */
  evidence: string;
  confident: boolean;
}

export function detectFramework(input: DetectionInput): Detection {
  const files = new Set(input.files);
  const deps = {
    ...input.packageJson?.dependencies,
    ...input.packageJson?.devDependencies,
  };

  // A config file is stronger evidence than a dependency, which can linger.
  const byFile: Array<[FrameworkId, string[]]> = [
    ["astro", ["astro.config.mjs", "astro.config.ts", "astro.config.js"]],
    ["next", ["next.config.js", "next.config.mjs", "next.config.ts"]],
    ["nuxt", ["nuxt.config.ts", "nuxt.config.js"]],
    ["sveltekit", ["svelte.config.js"]],
    ["eleventy", [".eleventy.js", "eleventy.config.js", "eleventy.config.mjs"]],
  ];

  for (const [id, candidates] of byFile) {
    const hit = candidates.find((name) => files.has(name));
    if (hit) {
      return { framework: FRAMEWORKS[id], evidence: hit, confident: true };
    }
  }

  const byDep: Array<[FrameworkId, string]> = [
    ["astro", "astro"],
    ["next", "next"],
    ["nuxt", "nuxt"],
    ["sveltekit", "@sveltejs/kit"],
    ["eleventy", "@11ty/eleventy"],
  ];

  for (const [id, dependency] of byDep) {
    if (deps[dependency]) {
      return {
        framework: FRAMEWORKS[id],
        evidence: `${dependency} in package.json`,
        confident: true,
      };
    }
  }

  return {
    framework: FRAMEWORKS.generic,
    evidence: "no framework config found",
    confident: false,
  };
}
