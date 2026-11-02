import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSchema } from "@greatcms/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./index.js";
import { defaultsOnlyPrompt, PromptCancelled, type PromptPort } from "./prompt.js";
import { scanProject, setupProject } from "./setup.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "greatcms-setup-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function answers(
  input: {
    selects?: string[];
    texts?: Record<string, string[]>;
    confirms?: Record<string, boolean[]>;
  } = {},
) {
  const choices = [...(input.selects ?? [])];
  const notes: string[] = [];
  const prompt: PromptPort = {
    interactive: true,
    note: (text) => notes.push(text),
    async select(question, options) {
      const wanted = choices.shift();
      const found = options.find(
        (c) =>
          c.value === wanted ||
          (typeof c.value === "object" && (c.value as { id?: string }).id === wanted),
      );
      if (!found)
        throw new Error(
          `Unexpected choice ${wanted} for ${question}: ${options.map((o) => o.value).join(", ")}`,
        );
      return found.value;
    },
    async text(question, initial) {
      return input.texts?.[question]?.shift() ?? initial;
    },
    async confirm(question, initial) {
      return (
        input.confirms?.[question]?.shift() ?? (question === "Add another field?" ? false : initial)
      );
    },
  };
  return { prompt, notes, choices };
}

async function put(path: string, source: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), source);
}

describe("project scanning", () => {
  it("discovers sibling sites like the SME reference directory without requiring workspace containers", async () => {
    await put("fish-farm/package.json", '{"dependencies":{"astro":"5"}}');
    await put("seed-store/package.json", '{"dependencies":{"astro":"5"}}');
    await put(
      "cms-only/.cms/schema.yaml",
      "version: 1\nregions:\n  home.hero:\n    fields:\n      title: { type: text }\n",
    );
    await put("assets/not-a-project.txt", "Ignore ordinary folders.");
    await put("archive/nested-site/package.json", "{}");
    expect((await scanProject(root)).projects).toEqual(["cms-only", "fish-farm", "seed-store"]);
  });

  it("does not let malformed neighboring projects or linked folders block choosing a healthy site", async () => {
    await put("apps/healthy/package.json", '{"dependencies":{"astro":"5"}}');
    await put("apps/broken/package.json", "not json");
    await put("node_modules/ignored/package.json", "not json");
    await put(".git/ignored/package.json", "not json");
    await symlink(join(root, "apps/healthy"), join(root, "linked-site"));
    expect((await scanProject(root)).projects).toEqual(["apps/broken", "apps/healthy"]);
    await expect(scanProject(join(root, "apps/broken"))).rejects.toThrow("Invalid package.json");
  });

  it("detects framework, manager, CMS and workspace apps without traversing dependencies or running code", async () => {
    await put(
      "package.json",
      JSON.stringify({ name: "workspace", packageManager: "pnpm@11.21.0" }),
    );
    await put("apps/store/package.json", JSON.stringify({ dependencies: { astro: "^6" } }));
    await put("apps/store/astro.config.mjs", 'throw new Error("must never execute");');
    await put("node_modules/unsafe/package.json", "not json");
    await put(".git/unsafe/package.json", "not json");
    const scan = await scanProject(root);
    expect(scan.manager).toBe("pnpm");
    expect(scan.projects).toEqual(["apps/store"]);
    const child = await scanProject(join(root, "apps/store"));
    expect(child.detection.framework.id).toBe("astro");
    expect(child.detection.evidence).toBe("astro.config.mjs");
  });

  it("rejects malformed package files and ambiguous CMS schemas", async () => {
    await put("package.json", "not json");
    await expect(scanProject(root)).rejects.toThrow("Invalid package.json");
    await put("package.json", "{}");
    await put(".cms/schema.yaml", "version: 1\n");
    await put(".cms/schema.json", '{"version":1}');
    await expect(scanProject(root)).rejects.toThrow("Multiple schema files");
  });

  it("does not follow linked configuration directories", async () => {
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(root, ".cms"));
    await expect(scanProject(root)).rejects.toThrow("Refusing linked path");
    expect(await readdir(join(root, "outside"))).toEqual([]);
  });
});

describe("interactive setup", () => {
  it("builds nested business details interactively instead of requiring handwritten YAML", async () => {
    const { prompt, notes } = answers({
      selects: ["astro", "custom", "region", "group", "text", "group", "text", "done"],
      texts: {
        "Region ID": ["company.details"],
        "Field name": ["owner", "name", "address", "city"],
        "Default text (used before the first edit)": ["Site owner", "Kigali"],
      },
      confirms: { "Add another field?": [true, false, false, false] },
    });
    await setupProject({ root, prompt, stdout: () => {} });
    const schema = parseSchema(await readFile(join(root, ".cms/schema.yaml"), "utf8"));
    expect(schema.regions["company.details"]).toMatchObject({
      fields: {
        owner: {
          type: "group",
          fields: {
            name: { type: "text", default: "Site owner" },
            address: { type: "group", fields: { city: { type: "text", default: "Kigali" } } },
          },
        },
      },
    });
    expect(notes.join("\n")).toContain("Fields inside Owner");
    expect(await readFile(join(root, ".cms/types.d.ts"), "utf8")).toContain("city: string");
  });

  it("inherits the workspace manager when an app has no separate lockfile", async () => {
    await put("package.json", '{"private":true,"packageManager":"pnpm@11.21.0"}');
    await put("apps/store/package.json", '{"dependencies":{"astro":"6"}}');
    const { prompt, notes } = answers({ selects: ["apps/store", "hero", "done"] });
    await setupProject({ root, prompt, stdout: () => {} });
    expect(notes.join("\n")).toContain("Package manager: pnpm");
    const pkg = JSON.parse(await readFile(join(root, "apps/store/package.json"), "utf8"));
    expect(pkg.dependencies["@greatcms/reader"]).toMatch(/^link:/);
  });

  it("is a no-op when setup is repeated without adding content", async () => {
    await setupProject({
      root,
      prompt: answers({ selects: ["generic", "hero", "done"] }).prompt,
      stdout: () => {},
    });
    const { prompt } = answers({ selects: ["done"] });
    const output: string[] = [];
    const confirm = prompt.confirm.bind(prompt);
    prompt.confirm = async (question, initial) => {
      expect(question).not.toBe("Apply this setup?");
      return confirm(question, initial);
    };
    await setupProject({ root, prompt, stdout: (text) => output.push(text) });
    expect(output).toEqual(["  ✓ Nothing to change.\n"]);
  });

  it("upgrades a reader helper an earlier version wrote, which broke once bundled", async () => {
    await put(
      ".cms/reader.mjs",
      `import { fileURLToPath } from "node:url";\nimport { createReader } from "@greatcms/reader";\n\n// Import from build or server code only, never from a browser bundle.\nexport const cms = createReader({ root: fileURLToPath(new URL("../", import.meta.url)) });\n`,
    );
    const { prompt } = answers({ selects: ["generic", "hero", "done"] });
    await setupProject({ root, prompt, stdout: () => {} });

    expect(await readFile(join(root, ".cms/reader.mjs"), "utf8")).toContain("process.cwd()");
  });

  it("preserves custom helper and type files without claiming their exports or adding an overwrite script", async () => {
    await put(".cms/reader.mjs", 'export const custom = "keep";');
    await put(".cms/types.d.ts", "export interface Custom { keep: string }");
    const { prompt } = answers({ selects: ["generic", "hero", "done"] });
    const output: string[] = [];
    await setupProject({ root, prompt, stdout: (text) => output.push(text) });
    expect(await readFile(join(root, ".cms/reader.mjs"), "utf8")).toBe(
      'export const custom = "keep";',
    );
    expect(await readFile(join(root, ".cms/types.d.ts"), "utf8")).toContain("interface Custom");
    expect(await readdir(join(root, ".cms"))).not.toContain("reader.d.mts");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["cms:types"]).toBeUndefined();
    expect(output.join("\n")).not.toContain("Import cms from .cms/reader.mjs");
  });

  it("builds several custom content shapes and a working standalone reader without a template", async () => {
    const { prompt, choices, notes } = answers({
      selects: [
        "astro",
        "custom",
        "region",
        "text",
        "block",
        "image",
        "sections",
        "feature",
        "collection",
        "text",
        "markdown",
        "title",
        "done",
      ],
      texts: {
        "Site name": ["Custom Company"],
        "Region ID": ["home.welcome", "home.sections"],
        "Field name": ["heading", "photo", "title"],
        "Default text (used before the first edit)": ["Made for you", "New article"],
        Name: ["feature", "articles"],
        "Singular entry label": ["Article"],
      },
    });
    expect(await setupProject({ root, prompt, stdout: () => {} })).toBe(0);
    expect(choices).toEqual([]);
    const schema = parseSchema(await readFile(join(root, ".cms/schema.yaml"), "utf8"));
    expect(Object.keys(schema.regions)).toEqual(["home.welcome", "home.sections"]);
    expect(schema.blocks.feature?.fields.photo?.type).toBe("image");
    expect(schema.collections.articles?.entryLabel).toBe("Article");
    expect(schema.collections.articles?.body).toBe("body");
    expect(notes.join("\n")).toContain("create .cms/schema.yaml");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["cms:types"]).toContain(".cms/types.d.ts");
    await mkdir(join(root, "node_modules/@greatcms"), { recursive: true });
    await symlink(resolve("../reader"), join(root, "node_modules/@greatcms/reader"));
    const script = `const { cms } = await import(${JSON.stringify(pathToFileURL(join(root, ".cms/reader.mjs")).href)}); console.log(cms.region("home.welcome").heading);`;
    expect(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: tmpdir(),
        encoding: "utf8",
      }).trim(),
    ).toBe("Made for you");
  });

  it("extends existing JSON schemas and preserves app configuration, content, versions, and scripts", async () => {
    const original = {
      name: "site",
      dependencies: { next: "16", "@greatcms/reader": "custom-version" },
      scripts: { dev: "next dev", "cms:check": "my-custom-check" },
      custom: { keep: true },
    };
    await put("package.json", JSON.stringify(original));
    await put(
      ".cms/schema.json",
      JSON.stringify({
        version: 1,
        regions: { "home.old": { fields: { title: { type: "text" } } } },
      }),
    );
    await put(".cms/config.json", '{"version":1,"content":{"regions":"data/regions"}}');
    await put("data/regions/home.old.json", '{"title":"Keep this"}');
    await put("next.config.mjs", 'export default { output: "export" };');
    const { prompt } = answers({
      selects: ["region", "text", "done"],
      texts: { "Region ID": ["home.new"] },
    });
    expect(await setupProject({ root, prompt, stdout: () => {} })).toBe(0);
    const schema = JSON.parse(await readFile(join(root, ".cms/schema.json"), "utf8"));
    expect(Object.keys(schema.regions)).toEqual(["home.old", "home.new"]);
    expect(await readFile(join(root, "next.config.mjs"), "utf8")).toBe(
      'export default { output: "export" };',
    );
    expect(await readFile(join(root, "data/regions/home.old.json"), "utf8")).toBe(
      '{"title":"Keep this"}',
    );
    expect(await readFile(join(root, ".cms/config.json"), "utf8")).toBe(
      '{"version":1,"content":{"regions":"data/regions"}}',
    );
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg).toMatchObject(original);
  });

  it("sets up a selected workspace app, leaving the root and other apps alone", async () => {
    await put("package.json", '{"private":true}');
    await put("apps/one/package.json", '{"dependencies":{"astro":"6"}}');
    await put("apps/two/package.json", '{"dependencies":{"next":"16"}}');
    const { prompt } = answers({
      selects: ["apps/one", "hero", "done"],
      confirms: { "Set up the build-time reader, generated types, and package scripts?": [false] },
    });
    expect(await setupProject({ root, prompt, stdout: () => {} })).toBe(0);
    expect(await readdir(root)).toEqual(["apps", "package.json"]);
    expect(await readdir(join(root, "apps/two"))).toEqual(["package.json"]);
    expect(await readFile(join(root, "apps/one/.cms/schema.yaml"), "utf8")).toContain("home.hero");
  });

  it("leaves a nonexistent target untouched when the review is declined", async () => {
    const { prompt } = answers({
      selects: ["generic", "hero", "done"],
      confirms: { "Apply this setup?": [false] },
    });
    expect(await setupProject({ root: join(root, "new-site"), prompt, stdout: () => {} })).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  it("does not write on Ctrl-C or on noninteractive invocation", async () => {
    const { prompt } = answers({ selects: ["generic", "custom"] });
    prompt.text = async () => {
      throw new PromptCancelled();
    };
    expect(
      await run({ cwd: root, argv: ["setup"], prompt, stdout: () => {}, stderr: () => {} }),
    ).toBe(130);
    expect(await readdir(root)).toEqual([]);
    await expect(
      setupProject({ root, prompt: defaultsOnlyPrompt(), stdout: () => {} }),
    ).rejects.toThrow("interactive terminal");
  });

  it("detects edits made while the review is open before writing any planned file", async () => {
    const { prompt } = answers({ selects: ["generic", "hero", "done"] });
    const confirm = prompt.confirm.bind(prompt);
    prompt.confirm = async (question, initial) => {
      if (question === "Apply this setup?") await put("package.json", '{"name":"concurrent-edit"}');
      return confirm(question, initial);
    };
    await expect(setupProject({ root, prompt, stdout: () => {} })).rejects.toThrow(
      "changed during setup",
    );
    expect(await readdir(root)).toEqual(["package.json"]);
    expect(await readFile(join(root, "package.json"), "utf8")).toContain("concurrent-edit");
  });

  it("re-prompts invalid field names and choices and preserves YAML comments", async () => {
    await put(
      ".cms/schema.yaml",
      "# Keep this project note\nversion: 1\nregions:\n  home.old:\n    fields:\n      title: { type: text }\n",
    );
    const { prompt, notes } = answers({
      selects: ["region", "select", "done"],
      texts: {
        "Field name": ["not valid", "style"],
        "Choices, separated by |": ["same|same", "yes|no: thanks"],
      },
      confirms: { "Set up the build-time reader, generated types, and package scripts?": [false] },
    });
    expect(await setupProject({ root, prompt, stdout: () => {} })).toBe(0);
    const source = await readFile(join(root, ".cms/schema.yaml"), "utf8");
    expect(source).toContain("# Keep this project note");
    expect(parseSchema(source).regions["home.intro"]).toMatchObject({
      fields: { style: { options: ["yes", "no: thanks"] } },
    });
    expect(notes.join("\n")).toContain("not a usable field name");
  });
});
