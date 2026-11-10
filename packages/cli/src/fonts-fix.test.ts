import { describe, expect, it } from "vitest";
import { familiesIn, planFonts } from "./fonts-fix.js";

const URL_TWO =
  "https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Source+Sans+3:wght@400;700&display=swap";

const CONFIG = `// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  site: 'https://example.com',
  integrations: [react()],
  prefetch: true,
});
`;

const LAYOUT = `---
import '@/styles/global.css';
const links = [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "anonymous" },
  { rel: "icon", href: "/favicon.svg" },
];
---
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  </head>
  <body><slot /></body>
</html>
`;

const site = (extra: Record<string, string> = {}) =>
  new Map(
    Object.entries({
      "astro.config.mjs": CONFIG,
      "src/layouts/Layout.astro": LAYOUT,
      "src/styles/global.css": `@import url('${URL_TWO}');\n\n@import './base.css';\n`,
      "src/styles/base.css": `:root {\n  --font-body: 'Source Sans 3', system-ui, sans-serif;\n  --font-display: "Archivo", 'Source Sans 3', sans-serif;\n  --brand: 'Archivo';\n}\n`,
      "src/pages/index.astro": `---\n---\n<h1>Archivo is a typeface</h1>\n`,
      ...extra,
    }),
  );

const plan = (files = site()) => planFonts(files, "astro.config.mjs", ["src/layouts/Layout.astro"]);

describe("reading a Google Fonts address", () => {
  it("takes the families, weights and styles from every way they are written", () => {
    expect(familiesIn(URL_TWO)).toEqual([
      expect.objectContaining({
        name: "Archivo",
        cssVariable: "--font-archivo",
        weights: [500, 600, 700, 800],
        styles: ["normal"],
      }),
      expect.objectContaining({
        name: "Source Sans 3",
        cssVariable: "--font-source-sans-3",
        weights: [400, 700],
      }),
    ]);
    expect(
      familiesIn("https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;1,400;1,700"),
    ).toEqual([
      expect.objectContaining({ name: "Lora", weights: [400, 700], styles: ["normal", "italic"] }),
    ]);
    expect(
      familiesIn("https://fonts.googleapis.com/css?family=Roboto:400,700|IBM+Plex+Mono"),
    ).toEqual([
      expect.objectContaining({ name: "Roboto", weights: [400, 700] }),
      expect.objectContaining({
        name: "IBM Plex Mono",
        weights: [400],
        fallbacks: ["ui-monospace", "monospace"],
      }),
    ]);
    expect(
      familiesIn("https://fonts.googleapis.com/css2?family=Inter:wght@300..700&amp;display=swap"),
    ).toEqual([expect.objectContaining({ name: "Inter", weights: [300, 700] })]);
  });

  it("reads nothing into an address that is not one, or that names something odd", () => {
    expect(familiesIn("https://fonts.googleapis.com/css2?display=swap")).toBeNull();
    expect(familiesIn("https://fonts.googleapis.com/css2?family=x'%7D%3B%20evil")).toBeNull();
    expect(familiesIn("not an address")).toBeNull();
  });
});

describe("planning the change", () => {
  it("edits the config, the layout and the styles, and takes every old way of loading out", () => {
    const { families, changes, problems } = plan();
    expect(problems).toEqual([]);
    expect(families.map((family) => family.name)).toEqual(["Archivo", "Source Sans 3"]);
    expect([...changes.keys()].toSorted()).toEqual([
      "astro.config.mjs",
      "src/layouts/Layout.astro",
      "src/styles/base.css",
      "src/styles/global.css",
    ]);

    const config = changes.get("astro.config.mjs") as string;
    expect(config).toContain("import { defineConfig, fontProviders } from 'astro/config';");
    expect(config).toMatch(
      /prefetch: true,\n {2}\/\/ Served from this site[\s\S]*fonts: \[[\s\S]*\],\n\}\);\n$/,
    );
    expect(config.match(/provider: fontProviders\.google\(\)/g)).toHaveLength(2);
    expect(config).toContain("weights: [500, 600, 700, 800],");
    expect(config).toContain("display: 'optional',");

    const layout = changes.get("src/layouts/Layout.astro") as string;
    expect(
      layout.startsWith("---\nimport { Font } from 'astro:assets';\nimport '@/styles/global.css';"),
    ).toBe(true);
    expect(layout).toContain(
      '<head>\n    <Font cssVariable="--font-archivo" preload />\n    <Font cssVariable="--font-source-sans-3" preload />\n    <meta charset="UTF-8" />',
    );
    expect(layout).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(layout).toContain('{ rel: "icon", href: "/favicon.svg" },');

    // The address holds semicolons of its own: the whole line goes, and the next import stays.
    expect(changes.get("src/styles/global.css")).toBe("@import './base.css';\n");
    expect(changes.get("src/styles/base.css")).toBe(
      ":root {\n  --font-body: var(--font-source-sans-3), system-ui, sans-serif;\n  --font-display: var(--font-archivo), var(--font-source-sans-3), sans-serif;\n  --brand: 'Archivo';\n}\n",
    );
    // Words on a page are not a font-family.
    expect(changes.has("src/pages/index.astro")).toBe(false);
  });

  it("finds nothing to do on a site that fetches no fonts", () => {
    const files = site({
      "src/styles/global.css": "@import './base.css';\n",
      "src/layouts/Layout.astro": "<html><head></head></html>",
    });
    expect(plan(files)).toEqual({ families: [], changes: new Map(), problems: [] });
  });

  it.each([
    [
      "a config that already sets fonts",
      { "astro.config.mjs": CONFIG.replace("prefetch: true,", "fonts: [],") },
      "already sets fonts",
    ],
    [
      "a config written another way",
      { "astro.config.mjs": "module.exports = { site: 'x' };" },
      "in the usual way",
    ],
    [
      "a layout that already uses Font",
      {
        "src/layouts/Layout.astro": LAYOUT.replace(
          "---\n",
          "---\nimport { Font } from 'astro:assets';\n",
        ),
      },
      "already uses Astro's Font",
    ],
    [
      "an address it cannot read",
      { "src/extra.css": "@import url('https://fonts.googleapis.com/css2?display=swap');" },
      "could not be read",
    ],
    [
      "a font loaded from script",
      { "src/load.ts": "document.head.append(link('https://fonts.gstatic.com/s/x.woff2'))" },
      "does not rewrite",
    ],
  ])("changes nothing at all for %s, and says why", (_name, extra, reason) => {
    const { changes, problems } = plan(site(extra));
    expect(changes.size).toBe(0);
    expect(problems.join("\n")).toContain(reason);
  });

  it("says so when there is no config or no layout to edit", () => {
    const { changes, problems } = planFonts(site(), undefined, []);
    expect(changes.size).toBe(0);
    expect(problems).toEqual([
      "no astro.config file was found",
      "no .astro file with a <head> was found",
    ]);
  });
});
