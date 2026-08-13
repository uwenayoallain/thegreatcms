import { parseConfig, parseSchema } from "@greatcms/spec";
import { describe, expect, it } from "vitest";
import { detectFramework, FRAMEWORKS } from "./detect.js";
import { nextSteps, planInit, type InitAnswers } from "./init.js";

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
      [".eleventy.js", "eleventy"],
      ["hugo.toml", "hugo"],
      ["_config.yml", "jekyll"],
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
      files: ["hugo.toml", "package.json"],
      packageJson: { dependencies: { next: "^15.0.0" } },
    });
    expect(detection.framework.id).toBe("hugo");
  });

  it("says so plainly when it cannot tell", () => {
    const detection = detectFramework({ files: ["index.html"] });
    expect(detection.framework.id).toBe("generic");
    expect(detection.confident).toBe(false);
  });

  it("puts content where each generator already looks for it", () => {
    expect(FRAMEWORKS.hugo.regionsDir).toBe("data/cms");
    expect(FRAMEWORKS.eleventy.regionsDir).toBe("_data/cms");
    expect(FRAMEWORKS.jekyll.regionsDir).toBe("_data/cms");
    expect(FRAMEWORKS.astro.regionsDir).toBe("src/content/cms");
  });
});

describe("what init generates", () => {
  it("produces a schema our own parser accepts, for every template", () => {
    for (const template of ["hero", "landing", "blog", "blank"] as const) {
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
    const hugo = answers({ framework: FRAMEWORKS.hugo, regionsDir: "data/cms" });
    const text = nextSteps(hugo, planInit(hugo));
    expect(text).toContain("site.Data.cms");

    const astro = answers();
    expect(nextSteps(astro, planInit(astro))).toContain("import hero from");
  });

  it("skips the snippet for the blank template, which has nothing to show yet", () => {
    const blank = answers({ template: "blank" });
    expect(nextSteps(blank, planInit(blank))).not.toContain("Read the managed region");
  });
});
