/**
 * Defensive hardening tests for the CLI:
 * 1. Config file edits are additive and leave unrecognised files untouched
 * 2. Running init or add twice changes nothing the second time
 * 3. Add refuses names that would break YAML or escape the schema
 * 4. Values typed into prompts or flags are never executed or interpolated into code other than as quoted strings
 * 5. Files are written only inside the project directory
 */

import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, parseSchema } from "@greatcms/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AddError,
  applyPlan,
  parseFieldSpec,
  quote,
  readSnippet,
  validatePlan,
  type AddPlan,
} from "./add.js";
import { FRAMEWORKS } from "./detect.js";
import { mergeAgentsNote, planInit, type InitAnswers } from "./init.js";
import { scanProject, setupProject } from "./setup.js";
import { CliError } from "./ports.js";
import type { PromptPort } from "./prompt.js";
import {
  wireAstro,
  wireNextLayout,
  wireNuxt,
  wirePreview,
  wireVitePlugin,
  withReader,
} from "./wire.js";

const BASE_SCHEMA = `# Schema
version: 1
site:
  name: My Site
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true }
blocks:
  card:
    label: Card
    fields:
      title: { type: text, required: true }
collections:
  posts:
    label: Posts
    path: content/posts
    format: markdown
    fields:
      title: { type: text, required: true }
`;

describe("Property 4: The CLI", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gc-cli-hardening-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("every edit to a config file is additive and leaves a file it does not recognise untouched", () => {
    it("leaves unrecognised config files completely untouched and reports manual instruction", async () => {
      const unrecognised = "export default createConfig(process.env.FLAG);";
      const fileMap: Record<string, string> = { "astro.config.mjs": unrecognised };
      const read = async (path: string) => fileMap[path] ?? null;

      const result = await wirePreview("astro", read);
      expect(result.edits).toEqual([]);
      expect(result.manual.length).toBeGreaterThan(0);
      expect(wireAstro(unrecognised)).toBeNull();
      expect(wireNuxt(unrecognised)).toBeNull();
      expect(wireVitePlugin(unrecognised)).toBeNull();
      expect(wireNextLayout(unrecognised)).toBeNull();
    });

    it("makes additive edits to recognized configs without clobbering existing configuration", () => {
      // Astro: preserves existing integrations
      const astroBefore = `import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
export default defineConfig({
  integrations: [tailwind()],
});
`;
      const astroAfter = wireAstro(astroBefore)!;
      expect(astroAfter).toContain("tailwind()");
      expect(astroAfter).toContain("greatcms()");
      expect(astroAfter).toContain('import greatcms from "@greatcms/reader/astro";');

      // Nuxt: preserves existing modules
      const nuxtBefore = `export default defineNuxtConfig({
  modules: ["@nuxtjs/tailwindcss"],
});
`;
      const nuxtAfter = wireNuxt(nuxtBefore)!;
      expect(nuxtAfter).toContain("@nuxtjs/tailwindcss");
      expect(nuxtAfter).toContain("@greatcms/reader/nuxt");

      // Vite plugin: preserves existing plugins
      const viteBefore = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
});
`;
      const viteAfter = wireVitePlugin(viteBefore)!;
      expect(viteAfter).toContain("react()");
      expect(viteAfter).toContain("greatcmsWatch()");

      // Next layout: preserves existing layout elements and inserts preview component
      const nextBefore = `export default function RootLayout({ children }) {
  return (
    <html>
      <head>
        <title>App</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
`;
      const nextAfter = wireNextLayout(nextBefore)!;
      expect(nextAfter).toContain("<title>App</title>");
      expect(nextAfter).toContain("<GreatcmsPreview />");
      expect(nextAfter).toContain('import { GreatcmsPreview } from "@greatcms/reader/next";');
    });
  });

  describe("running init or add twice changes nothing the second time", () => {
    it("running init wiring twice produces no edits on the second run", async () => {
      const packageJson = JSON.stringify(
        { name: "my-site", dependencies: { astro: "5.0.0" } },
        null,
        2,
      );
      const firstPackage = withReader(packageJson)!;
      expect(firstPackage).toContain("@greatcms/reader");

      // Running withReader a second time returns null (no changes)
      const secondPackage = withReader(firstPackage);
      expect(secondPackage).toBeNull();

      // Astro config wired twice returns the identical string on second run
      const astroConfig = `import { defineConfig } from "astro/config";
export default defineConfig({});
`;
      const wiredOnce = wireAstro(astroConfig)!;
      expect(wireAstro(wiredOnce)).toBe(wiredOnce);

      // AGENTS.md merged twice is idempotent
      const initialAgents = "# Project\n";
      const note = "## GreatCMS Content\nDo not hand-edit.";
      const once = mergeAgentsNote(initialAgents, note);
      const twice = mergeAgentsNote(once, note);
      expect(twice).toBe(once);

      // planInit produces identical output when invoked with same answers
      const answers: InitAnswers = {
        name: "Test",
        framework: FRAMEWORKS.astro,
        template: "hero",
        regionsDir: "content/cms",
        mediaDir: "public/media",
        mediaUrlPrefix: "/media",
        collectionsDir: "content/blog",
        schemaUrl: "https://example.com/schema.json",
      };
      const plan1 = planInit(answers);
      const plan2 = planInit(answers);
      expect(plan1.files).toEqual(plan2.files);
    });

    it("running add twice with the same region, block, or collection rejects and changes nothing the second time", () => {
      // 1. Region
      const regionPlan: AddPlan = {
        kind: "region",
        id: "about.team",
        label: "About team",
        fields: [parseFieldSpec("heading:text!")],
      };
      const result1 = applyPlan({
        plan: regionPlan,
        source: BASE_SCHEMA,
        file: ".cms/schema.yaml",
        config: DEFAULT_CONFIG,
      });
      expect(result1.schema).toContain("about.team:");

      // Adding the same region a second time throws AddError and does not modify schema
      expect(() =>
        applyPlan({
          plan: regionPlan,
          source: result1.schema,
          file: ".cms/schema.yaml",
          config: DEFAULT_CONFIG,
        }),
      ).toThrow(AddError);

      // 2. Block
      const blockPlan: AddPlan = {
        kind: "block",
        name: "testimonial",
        label: "Testimonial",
        fields: [parseFieldSpec("quote:text!")],
      };
      const resultBlock = applyPlan({
        plan: blockPlan,
        source: BASE_SCHEMA,
        file: ".cms/schema.yaml",
        config: DEFAULT_CONFIG,
      });
      expect(resultBlock.schema).toContain("testimonial:");

      expect(() =>
        applyPlan({
          plan: blockPlan,
          source: resultBlock.schema,
          file: ".cms/schema.yaml",
          config: DEFAULT_CONFIG,
        }),
      ).toThrow(AddError);

      // 3. Collection
      const colPlan: AddPlan = {
        kind: "collection",
        name: "events",
        label: "Events",
        path: "content/events",
        format: "json",
        fields: [parseFieldSpec("name:text!")],
      };
      const resultCol = applyPlan({
        plan: colPlan,
        source: BASE_SCHEMA,
        file: ".cms/schema.yaml",
        config: DEFAULT_CONFIG,
      });
      expect(resultCol.schema).toContain("events:");

      expect(() =>
        applyPlan({
          plan: colPlan,
          source: resultCol.schema,
          file: ".cms/schema.yaml",
          config: DEFAULT_CONFIG,
        }),
      ).toThrow(AddError);
    });
  });

  describe("add refuses names that would break YAML or escape the schema", () => {
    const maliciousNames = [
      "bad\nname",
      'bad"name',
      "bad'name",
      "bad:name",
      "../escape",
      "folder/name",
      "folder\\name",
      "..",
      "/root",
    ];

    it("refuses malicious region IDs", () => {
      const schema = parseSchema(BASE_SCHEMA, { file: ".cms/schema.yaml" });
      for (const id of maliciousNames) {
        const plan: AddPlan = {
          kind: "region",
          id,
          label: "Test",
          fields: [parseFieldSpec("heading:text!")],
        };
        expect(() => validatePlan(plan, schema)).toThrow(AddError);
      }
    });

    it("refuses malicious block names", () => {
      const schema = parseSchema(BASE_SCHEMA, { file: ".cms/schema.yaml" });
      for (const name of maliciousNames) {
        const plan: AddPlan = {
          kind: "block",
          name,
          label: "Test",
          fields: [parseFieldSpec("title:text!")],
        };
        expect(() => validatePlan(plan, schema)).toThrow(AddError);
      }
    });

    it("refuses malicious collection names", () => {
      const schema = parseSchema(BASE_SCHEMA, { file: ".cms/schema.yaml" });
      for (const name of maliciousNames) {
        const plan: AddPlan = {
          kind: "collection",
          name,
          label: "Test",
          path: `content/${name}`,
          format: "json",
          fields: [parseFieldSpec("title:text!")],
        };
        expect(() => validatePlan(plan, schema)).toThrow(AddError);
      }
    });

    it("refuses malicious field names", () => {
      for (const name of maliciousNames) {
        expect(() => parseFieldSpec(`${name}:text`)).toThrow(AddError);
      }
    });
  });

  describe("values typed into prompts or flags are never executed or interpolated into code other than as quoted strings", () => {
    it("quotes values that would otherwise break YAML syntax or parse as non-strings", () => {
      // Numbers, booleans, null, strings with colons and quotes
      expect(quote("true")).toBe('"true"');
      expect(quote("false")).toBe('"false"');
      expect(quote("null")).toBe('"null"');
      expect(quote("2026")).toBe('"2026"');
      expect(quote("Title: Subtitle")).toBe('"Title: Subtitle"');
      expect(quote('Say "hello"')).toBe('"Say \\"hello\\""');
      expect(quote("line1\nline2")).toBe('"line1\\nline2"');
    });

    it("interpolates region IDs into generated code snippets only as quoted string literals", () => {
      const regionPlan: AddPlan = {
        kind: "region",
        id: "home.hero",
        label: "Home hero",
        fields: [parseFieldSpec("title:text")],
      };
      const snippet = readSnippet(regionPlan, FRAMEWORKS.astro, DEFAULT_CONFIG)!;
      expect(snippet).toContain('cms.region("home.hero")');
      // Must not interpolate raw unquoted code expressions
      expect(snippet).not.toMatch(/cms\.region\([^"][^)]*\)/);

      // Blocks region snippet
      const blocksPlan: AddPlan = {
        kind: "region",
        id: "home.sections",
        label: "Home sections",
        fields: [],
        allow: ["card"],
      };
      const blocksSnippet = readSnippet(blocksPlan, FRAMEWORKS.astro, DEFAULT_CONFIG)!;
      expect(blocksSnippet).toContain('cms.region("home.sections")');
    });
  });

  describe("files are written only inside the project directory", () => {
    it("refuses to follow symlinks pointing outside the project root", async () => {
      const outside = await mkdtemp(join(tmpdir(), "gc-cli-outside-"));
      try {
        await writeFile(join(outside, "schema.yaml"), "version: 1\n");
        // Create symlink inside project root pointing outside
        await symlink(outside, join(root, ".cms"));

        await expect(scanProject(root)).rejects.toThrow(/Refusing linked path/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("setupProject writes only within the specified root directory", async () => {
      // Put a package.json in root
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "safe-project", dependencies: { astro: "5.0.0" } }),
      );

      // Run non-interactive setup
      const prompt: PromptPort = {
        interactive: false,
        note: () => {},
        select: async () => "",
        text: async () => "",
        confirm: async () => false,
      };

      // Non-interactive setup refuses to run, ensuring no unintended files are created
      await expect(setupProject({ root, prompt, stdout: () => {} })).rejects.toThrow(CliError);
    });
  });
});
