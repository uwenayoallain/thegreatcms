import { parseConfig, parseSchema } from "@greatcms/spec";
import { describe, expect, it } from "vitest";
import { detectFramework, FRAMEWORKS } from "./detect.js";
import { nextSteps, planInit, planStarter, TEMPLATES, type InitAnswers } from "./init.js";

function answers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  const framework = overrides.framework ?? FRAMEWORKS.astro;
  return {
    name: "My Site",
    framework,
    template: "hero",
    regionsDir: framework.regionsDir,
    mediaDir: framework.mediaDir,
    mediaUrlPrefix: framework.mediaUrlPrefix,
    collectionsDir: framework.collectionsDir,
    branch: "main",
    schemaUrl: "https://example.com/schema.json",
    ...overrides,
  };
}

const file = (plan: ReturnType<typeof planInit>, path: string) =>
  plan.files.find((entry) => entry.path === path)?.content ?? "";

describe("detecting a framework", () => {
  it("recognises each generator by its config file", () => {
    const cases: Array<[string, string]> = [
      ["astro.config.mjs", "astro"],
      ["next.config.js", "next"],
      ["nuxt.config.ts", "nuxt"],
      ["svelte.config.js", "sveltekit"],
    ];
    for (const [configFile, id] of cases) {
      expect(detectFramework({ files: [configFile] }).framework.id, configFile).toBe(id);
    }
  });

  it("falls back to dependencies when there is no config file", () => {
    const detection = detectFramework({
      files: ["package.json"],
      packageJson: { dependencies: { astro: "^5.0.0" } },
    });
    expect(detection.framework.id).toBe("astro");
    expect(detection.evidence).toContain("package.json");
  });

  it("prefers a config file over a stale dependency", () => {
    const detection = detectFramework({
      files: ["astro.config.mjs", "package.json"],
      packageJson: { dependencies: { next: "^15.0.0" } },
    });
    expect(detection.framework.id).toBe("astro");
  });

  it("says so plainly when it cannot tell", () => {
    const detection = detectFramework({ files: ["index.html"] });
    expect(detection.framework.id).toBe("generic");
    expect(detection.confident).toBe(false);
  });

  it("puts content where each generator already looks for it", () => {
    expect(FRAMEWORKS.astro.regionsDir).toBe("src/content/cms");
    expect(FRAMEWORKS.next.regionsDir).toBe("content/cms");
  });
});

describe("what init generates", () => {
  it("produces a schema our own parser accepts, for every template", () => {
    for (const template of ["hero", "landing", "business", "blog", "blank"] as const) {
      const plan = planInit(answers({ template }));
      const schema = parseSchema(file(plan, ".cms/schema.yaml"));
      expect(Object.keys(schema.regions).length, template).toBeGreaterThan(0);
    }
  });

  it("produces a config our own parser accepts", () => {
    const plan = planInit(answers());
    const config = parseConfig(file(plan, ".cms/config.yaml"));
    expect(config.content.regions).toBe("src/content/cms");
    expect(config.publish.branch).toBe("main");
  });

  it("writes the editor schema line so authors get autocomplete", () => {
    const plan = planInit(answers());
    expect(file(plan, ".cms/schema.yaml")).toContain("# yaml-language-server: $schema=");
    expect(file(plan, ".cms/config.yaml")).toContain("# yaml-language-server: $schema=");
  });

  it("gives the landing template a reorderable block list", () => {
    const schema = parseSchema(
      file(planInit(answers({ template: "landing" })), ".cms/schema.yaml"),
    );
    expect(schema.regions["home.body"]).toMatchObject({ type: "blocks" });
    expect(Object.keys(schema.blocks)).toEqual(["feature", "text", "cta"]);
  });

  it("gives the blog template a Markdown collection", () => {
    const schema = parseSchema(file(planInit(answers({ template: "blog" })), ".cms/schema.yaml"));
    expect(schema.collections.blog).toMatchObject({ format: "markdown", body: "content" });
  });

  it("gives a business site reusable sections and structured products", () => {
    const schema = parseSchema(
      file(planInit(answers({ name: "Lake Farm", template: "business" })), ".cms/schema.yaml"),
    );

    expect(Object.keys(schema.regions)).toEqual([
      "site.identity",
      "site.contact",
      "site.seo",
      "home.hero",
      "home.sections",
    ]);
    expect(schema.regions["home.sections"]).toMatchObject({
      type: "blocks",
      allow: ["feature-grid", "process", "stats", "story", "products", "faq-list", "cta"],
    });
    expect(schema.blocks["feature-grid"]?.fields.items).toMatchObject({
      type: "blocks",
      allow: ["feature"],
    });
    expect(schema.blocks.process?.fields.steps).toMatchObject({
      type: "blocks",
      allow: ["step"],
      min: 2,
      max: 8,
    });
    expect(schema.collections.products).toMatchObject({
      path: "src/content/products",
      format: "json",
      slug: "name",
    });
    expect(schema.collections.products?.fields.details).toMatchObject({
      type: "list",
      of: { type: "text" },
    });
    expect(schema.collections.pages).toMatchObject({
      path: "src/content/pages",
      format: "json",
      slug: "title",
    });
    expect(schema.collections.pages?.fields.sections).toMatchObject({
      type: "blocks",
      allow: ["feature-grid", "process", "stats", "story", "products", "faq-list", "cta"],
    });
    expect(schema.regions["site.identity"]).toMatchObject({ default: { name: "Lake Farm" } });
    expect(schema.regions["site.identity"]).toMatchObject({
      fields: { owner: { type: "group" } },
    });
  });

  it("ships defaults so the site renders before anyone edits anything", () => {
    const schema = parseSchema(file(planInit(answers()), ".cms/schema.yaml"));
    expect(schema.regions["home.hero"]).toMatchObject({ default: { heading: "Welcome" } });
  });

  it("uses the chosen directories, not the framework's defaults, when told to", () => {
    const plan = planInit(answers({ regionsDir: "data/managed" }));
    expect(parseConfig(file(plan, ".cms/config.yaml")).content.regions).toBe("data/managed");
  });

  it("quotes a site name YAML would otherwise mangle", () => {
    const schema = parseSchema(
      file(planInit(answers({ name: "Yes: really" })), ".cms/schema.yaml"),
    );
    expect(schema.site?.name).toBe("Yes: really");
  });
});

describe("next steps", () => {
  it("shows how to read the region in the detected framework", () => {
    const next = answers({ framework: FRAMEWORKS.next, regionsDir: "content/cms" });
    expect(nextSteps(next, planInit(next))).toContain("a server component");

    const astro = answers();
    const output = nextSteps(astro, planInit(astro));
    expect(output).toContain("npm install @greatcms/reader");
    expect(output).toContain('cms.region("home.hero")');
  });

  it("never asks a new site to import a content file that does not exist yet", () => {
    for (const framework of Object.values(FRAMEWORKS)) {
      const output = nextSteps(
        answers({ framework, regionsDir: framework.regionsDir }),
        planInit(answers({ framework, regionsDir: framework.regionsDir })),
      );
      expect(output, framework.id).not.toContain("home.hero.json");
    }
  });

  it("describes the blank template as what it writes: a schema with one example region", () => {
    const plan = planInit(answers({ template: "blank" }));
    expect(plan.files.map((entry) => entry.path)).toEqual([".cms/schema.yaml", ".cms/config.yaml"]);
    const schema = parseSchema(file(plan, ".cms/schema.yaml"));
    expect(Object.keys(schema.regions)).toEqual(["home.hero"]);
    expect(Object.keys(schema.collections)).toEqual([]);
    const hint = TEMPLATES.find((template) => template.id === "blank")?.hint ?? "";
    expect(hint).toBe("one example region with a heading: you write the rest");
    expect(hint).not.toMatch(/config only/);
  });

  it("skips the snippet for the blank template, which has nothing to show yet", () => {
    const blank = answers({ template: "blank" });
    expect(nextSteps(blank, planInit(blank))).not.toContain("Read the managed region");
  });

  it("names every content shape the business starter creates", () => {
    const business = answers({ template: "business" });
    const output = nextSteps(business, planInit(business));

    expect(output).toContain('cms.region("site.identity")');
    expect(output).toContain('cms.blocks("home.sections")');
    expect(output).toContain('cms.collection("products")');
    expect(output).toContain('cms.collection("pages")');
    expect(output).toContain("one dynamic route");
  });
});

describe("a starter for the studio", () => {
  it("decides the framework and folders from the site's own files, without asking", () => {
    const plan = planStarter({
      name: "Bakery",
      template: "landing",
      files: ["next.config.ts", "package.json"],
      packageJson: { dependencies: { next: "15" } },
    });

    expect(plan.framework.id).toBe("next");
    expect(plan.files.map((entry) => entry.path)).toEqual([".cms/schema.yaml", ".cms/config.yaml"]);
    expect(parseSchema(file(plan, ".cms/schema.yaml"), { file: "schema.yaml" }).site.name).toBe(
      "Bakery",
    );
    expect(parseConfig(file(plan, ".cms/config.yaml")).content.regions).toBe("content/cms");
  });
});
