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

export const FRAMEWORKS: Record<FrameworkId, Framework> = {
  astro: {
    id: "astro",
    label: "Astro",
    regionsDir: "src/content/cms",
    collectionsDir: "src/content/blog",
    mediaDir: "public/media",
    mediaUrlPrefix: "/media",
    snippet: (regionId, dir) =>
      [
        "---",
        `import hero from "../../${dir}/${regionId}.json";`,
        "---",
        "",
        "<h1>{hero.heading}</h1>",
        "",
        "// or, with types and schema defaults applied:",
        '// import { createReader } from "@greatcms/reader";',
        "// const cms = createReader();",
        `// const hero = cms.region("${regionId}");`,
      ].join("\n"),
  },
  next: {
    id: "next",
    label: "Next.js",
    regionsDir: "content/cms",
    collectionsDir: "content/blog",
    mediaDir: "public/media",
    mediaUrlPrefix: "/media",
    snippet: (regionId, dir) =>
      [
        `import hero from "@/${dir}/${regionId}.json";`,
        "",
        "export default function Page() {",
        "  return <h1>{hero.heading}</h1>;",
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
    snippet: (regionId, dir) =>
      [
        "<script setup>",
        `import hero from "~/${dir}/${regionId}.json";`,
        "</script>",
        "",
        "<template><h1>{{ hero.heading }}</h1></template>",
      ].join("\n"),
  },
  sveltekit: {
    id: "sveltekit",
    label: "SvelteKit",
    regionsDir: "src/content/cms",
    collectionsDir: "src/content/blog",
    mediaDir: "static/media",
    mediaUrlPrefix: "/media",
    snippet: (regionId, dir) =>
      [
        "<script>",
        `  import hero from "$lib/../${dir}/${regionId}.json";`,
        "</script>",
        "",
        "<h1>{hero.heading}</h1>",
      ].join("\n"),
  },
  eleventy: {
    id: "eleventy",
    label: "Eleventy",
    // Anything under _data becomes global data automatically, so a managed region needs no wiring.
    regionsDir: "_data/cms",
    collectionsDir: "content/blog",
    mediaDir: "public/media",
    mediaUrlPrefix: "/media",
    snippet: (regionId) =>
      [
        "<!-- _data is global data in Eleventy, so this just works: -->",
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
    snippet: (regionId, dir) =>
      [
        "// It is JSON on disk. Read it however your language reads JSON:",
        `//   ${dir}/${regionId}.json`,
        "",
        `const hero = JSON.parse(readFileSync("${dir}/${regionId}.json", "utf8"));`,
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
