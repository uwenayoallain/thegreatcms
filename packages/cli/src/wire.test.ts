/** Wiring the live preview into a framework's own config, without breaking a config we do not recognise. */

import { describe, expect, it } from "vitest";
import {
  packageManager,
  READER_RANGE,
  wireAstro,
  wireNextLayout,
  wireNuxt,
  wirePreview,
  wireVitePlugin,
  withReader,
} from "./wire.js";

const reader = (files: Record<string, string>) => async (path: string) => files[path] ?? null;

describe("Astro", () => {
  it("fills the empty config a new project starts with, in its own quote style", () => {
    const out = wireAstro(
      "// @ts-check\nimport { defineConfig } from 'astro/config';\n\nexport default defineConfig({});\n",
    );
    expect(out).toBe(
      "// @ts-check\nimport { defineConfig } from 'astro/config';\nimport greatcms from '@greatcms/reader/astro';\n\nexport default defineConfig({ integrations: [greatcms()] });\n",
    );
  });

  it("joins integrations a site already has", () => {
    const out = wireAstro(
      'import { defineConfig } from "astro/config";\nimport mdx from "@astrojs/mdx";\nexport default defineConfig({\n  integrations: [mdx()],\n});\n',
    );
    expect(out).toContain("integrations: [greatcms(), mdx()]");
    expect(out).toContain(
      'import mdx from "@astrojs/mdx";\nimport greatcms from "@greatcms/reader/astro";',
    );
  });

  it("adds the key to a config that has none", () => {
    expect(
      wireAstro(
        'import { defineConfig } from "astro/config";\nexport default defineConfig({\n  site: "https://x.dev",\n});\n',
      ),
    ).toContain('defineConfig({\n  integrations: [greatcms()],\n  site: "https://x.dev",');
  });

  it("leaves a config it cannot read alone", () => {
    expect(wireAstro("export default makeConfig(process.env);\n")).toBeNull();
  });

  it("changes nothing the second time", () => {
    const once = wireAstro(
      'import { defineConfig } from "astro/config";\nexport default defineConfig({});\n',
    )!;
    expect(wireAstro(once)).toBe(once);
  });
});

describe("Nuxt", () => {
  it("adds the module to a new project's config", () => {
    expect(
      wireNuxt("export default defineNuxtConfig({\n  devtools: { enabled: true },\n});\n"),
    ).toBe(
      'export default defineNuxtConfig({\n  modules: ["@greatcms/reader/nuxt"],\n  devtools: { enabled: true },\n});\n',
    );
  });

  it("joins modules a site already uses", () => {
    expect(wireNuxt("export default defineNuxtConfig({ modules: ['@nuxt/image'] });\n")).toContain(
      "modules: ['@greatcms/reader/nuxt', '@nuxt/image']",
    );
  });
});

describe("SvelteKit", () => {
  it("adds the watcher to the Vite plugins", () => {
    const out = wireVitePlugin(
      "import { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n\tplugins: [sveltekit()]\n});\n",
    );
    expect(out).toContain("plugins: [greatcmsWatch(), sveltekit()]");
    expect(out).toContain("import { greatcmsWatch } from '@greatcms/reader/sveltekit';");
  });

  it("creates the server hook when there is none, and only asks when there is one", async () => {
    const vite =
      "import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n";
    const fresh = await wirePreview(
      "sveltekit",
      reader({ "vite.config.ts": vite, "tsconfig.json": "{}" }),
    );
    expect(fresh.edits.map((edit) => edit.path)).toEqual(["vite.config.ts", "src/hooks.server.ts"]);
    expect(fresh.edits[1]!.content).toContain("export { greatcmsHandle as handle }");
    expect(fresh.manual).toEqual([]);

    const existing = await wirePreview(
      "sveltekit",
      reader({ "vite.config.js": vite, "src/hooks.server.js": "export const handle = auth;\n" }),
    );
    expect(existing.edits.map((edit) => edit.path)).toEqual(["vite.config.js"]);
    expect(existing.manual[0]).toContain("sequence()");
  });
});

describe("Next.js", () => {
  const layout = [
    'import type { Metadata } from "next";',
    'import "./globals.css";',
    "",
    "export default function RootLayout({ children }) {",
    "  return (",
    '    <html lang="en">',
    "      <body>{children}</body>",
    "    </html>",
    "  );",
    "}",
    "",
  ].join("\n");

  it("gives the root layout a head holding the preview", () => {
    const out = wireNextLayout(layout)!;
    expect(out).toContain(
      'import "./globals.css";\nimport { GreatcmsPreview } from "@greatcms/reader/next";',
    );
    expect(out).toContain("      <head>\n        <GreatcmsPreview />\n      </head>\n      <body>");
  });

  it("uses the head a layout already has", () => {
    const out = wireNextLayout(
      layout.replace(
        "      <body>",
        '      <head>\n        <link rel="icon" href="/i.svg" />\n      </head>\n      <body>',
      ),
    )!;
    expect(out).toContain("      <head>\n        <GreatcmsPreview />\n        <link");
    expect(out.match(/<head>/g)).toHaveLength(1);
  });

  it("finds the layout under src/app, and asks for a person without one", async () => {
    expect(
      (await wirePreview("next", reader({ "src/app/layout.tsx": layout }))).edits[0]!.path,
    ).toBe("src/app/layout.tsx");
    expect((await wirePreview("next", reader({}))).manual[0]).toContain("<GreatcmsPreview />");
  });
});

describe("package.json", () => {
  it("adds the reader as a dependency, sorted, keeping the file's indentation", () => {
    const out = withReader(
      '{\n\t"name": "x",\n\t"dependencies": {\n\t\t"next": "16.0.0"\n\t}\n}\n',
    )!;
    expect(JSON.parse(out).dependencies).toEqual({
      "@greatcms/reader": READER_RANGE,
      next: "16.0.0",
    });
    expect(out).toContain('\t"name"');
  });

  it("leaves a project that already has it alone", () => {
    expect(withReader('{ "devDependencies": { "@greatcms/reader": "^0.1.0" } }')).toBeNull();
  });

  it("asks for this release of the reader", () => {
    expect(READER_RANGE).toMatch(/^\^\d+\.\d+\.\d+/);
  });

  it("names the package manager the project uses", () => {
    expect(packageManager(["bun.lock"], {})).toBe("bun");
    expect(packageManager([], { packageManager: "pnpm@11.0.0" })).toBe("pnpm");
    expect(packageManager([], {})).toBe("npm");
  });
});

describe("arrays written one item per line", () => {
  it("get the new item on a line of its own, at the same indentation", () => {
    expect(
      wireVitePlugin(
        "import { sveltekit } from '@sveltejs/kit/vite';\nexport default {\n\tplugins: [\n\t\tsveltekit()\n\t]\n};\n",
      ),
    ).toContain("plugins: [\n\t\tgreatcmsWatch(),\n\t\tsveltekit()\n\t]");
  });
});
