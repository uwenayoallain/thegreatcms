/* eslint-disable no-await-in-loop -- Prompts and transactional writes depend on the previous step. */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  unlink,
  rename,
  link,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, parseDocument, stringify } from "yaml";
import {
  parseConfig,
  parseSchema,
  SpecError,
  type CmsSchema,
  type CollectionFormat,
} from "@greatcms/spec";
import {
  AddError,
  FIELD_TYPES,
  labelFor,
  parseFieldSpec,
  renderPlan,
  sectionFor,
  validatePlan,
  type AddPlan,
  type FieldSpec,
} from "./add.js";
import { detectFramework, FRAMEWORKS, type Detection } from "./detect.js";
import { planInit, DEFAULT_SCHEMA_URL, TEMPLATES } from "./init.js";
import { CliError } from "./ports.js";
import type { PromptPort } from "./prompt.js";
import { renderTypes } from "./types.js";

interface PackageJson {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

interface SourceFile {
  path: string;
  source: string;
}
export interface ProjectScan {
  root: string;
  files: string[];
  packageJson?: PackageJson;
  packageSource: string | null;
  detection: Detection;
  manager: string;
  schema: SourceFile | null;
  config: SourceFile | null;
  projects: string[];
}

async function optionalRead(root: string, path: string): Promise<string | null> {
  await safePath(root, path);
  try {
    return await readFile(join(root, path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(`Cannot read ${join(root, path)}: ${(error as Error).message}`);
  }
}

/** The helper earlier versions wrote, replaced because bundlers move the file it resolves from. */
const LEGACY_READER_HELPER = `import { fileURLToPath } from "node:url";\nimport { createReader } from "@greatcms/reader";\n\n// Import from build or server code only, never from a browser bundle.\nexport const cms = createReader({ root: fileURLToPath(new URL("../", import.meta.url)) });\n`;

/**
 * Whether this CLI is running from a GreatCMS source checkout. An installed CLI sits in
 * someone's node_modules, and a path to it would only exist on that one machine.
 */
async function isGreatcmsCheckout(folder: string): Promise<boolean> {
  const manifest = await readIfPresent(join(folder, "package.json"));
  const workspace = await readIfPresent(join(folder, "pnpm-workspace.yaml"));
  return workspace !== null && manifest !== null && JSON.parse(manifest).name === "thegreatcms";
}

/** Reads a file outside the project being set up, where its own link rules do not apply. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function safePath(root: string, path: string): Promise<void> {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith("../") || rel === "..") throw new CliError(`Path leaves the project: ${path}`);
  // Never follow a link inside the project out of it. The project folder itself, and
  // whatever it sits under (macOS /tmp, a linked home), are the user's choice.
  const top = resolve(root);
  for (let current = target; current !== top; current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new CliError(`Refusing linked path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) break;
  }
}

async function configSource(root: string, name: string): Promise<SourceFile | null> {
  const found: SourceFile[] = [];
  for (const ext of ["json", "yaml", "yml"]) {
    const path = `.cms/${name}.${ext}`;
    const source = await optionalRead(root, path);
    if (source !== null) found.push({ path, source });
  }
  if (found.length > 1)
    throw new CliError(
      `Multiple ${name} files found. Keep one before setup: ${found.map((f) => f.path).join(", ")}`,
    );
  return found[0] ?? null;
}

async function regularPath(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return kind === "file" ? entry.isFile() : entry.isDirectory();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

async function hasProjectMarker(root: string): Promise<boolean> {
  if (await regularPath(join(root, "package.json"), "file")) return true;
  if (!(await regularPath(join(root, ".cms"), "directory"))) return false;
  return (
    await Promise.all(
      ["json", "yaml", "yml"].map((ext) => regularPath(join(root, `.cms/schema.${ext}`), "file")),
    )
  ).some(Boolean);
}

async function discoverProjects(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ignored = new Set([
    "node_modules",
    "dist",
    "build",
    "coverage",
    "public",
    "static",
    "assets",
  ]);
  const candidates = entries
    .filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith(".") && !ignored.has(entry.name),
    )
    .map((entry) => entry.name);
  const containers = candidates.filter((name) => ["apps", "packages", "examples"].includes(name));
  const nested = await Promise.all(
    containers.map(async (container) => {
      const children = await readdir(join(root, container), { withFileTypes: true });
      return children
        .filter(
          (entry) => entry.isDirectory() && !entry.name.startsWith(".") && !ignored.has(entry.name),
        )
        .map((entry) => `${container}/${entry.name}`);
    }),
  );
  const found = await Promise.all(
    [...candidates, ...nested.flat()].map(async (path) =>
      (await hasProjectMarker(join(root, path))) ? path : null,
    ),
  );
  return found.filter((path): path is string => path !== null).toSorted();
}

export async function scanProject(root: string, discover = true): Promise<ProjectScan> {
  root = resolve(root);
  await safePath(root, ".");
  let files: string[];
  try {
    files = (await readdir(root)).toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new CliError(`Cannot scan ${root}: ${(error as Error).message}`);
    files = [];
  }
  const packageSource = await optionalRead(root, "package.json");
  let packageJson: PackageJson | undefined;
  if (packageSource !== null) {
    try {
      packageJson = JSON.parse(packageSource);
      if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson))
        throw new Error("Expected an object");
      for (const key of ["scripts", "dependencies", "devDependencies"] as const) {
        const value = packageJson[key];
        if (
          value !== undefined &&
          (!value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.values(value).some((v) => typeof v !== "string"))
        )
          throw new Error(`Invalid ${key}`);
      }
    } catch (error) {
      throw new CliError(`Invalid package.json in ${root}: ${(error as Error).message}`);
    }
  }
  const schema = await configSource(root, "schema");
  const config = await configSource(root, "config");
  if (schema) parseSchema(schema.source, { file: schema.path });
  if (config) parseConfig(config.source, config.path);
  const projects = discover ? await discoverProjects(root) : [];
  const declared =
    typeof packageJson?.packageManager === "string"
      ? packageJson.packageManager.split("@")[0]
      : undefined;
  const manager =
    declared && ["pnpm", "npm", "yarn", "bun"].includes(declared)
      ? declared
      : files.includes("pnpm-lock.yaml")
        ? "pnpm"
        : files.includes("yarn.lock")
          ? "yarn"
          : files.includes("bun.lock") || files.includes("bun.lockb")
            ? "bun"
            : packageJson
              ? "npm"
              : "pnpm";
  return {
    root,
    files,
    packageJson,
    packageSource,
    schema,
    config,
    projects,
    manager,
    detection: detectFramework({ files, packageJson }),
  };
}

async function validText(
  prompt: PromptPort,
  question: string,
  initial: string,
  validate: (answer: string) => void,
): Promise<string> {
  while (true) {
    const answer = await prompt.text(question, initial);
    try {
      validate(answer);
      return answer;
    } catch (error) {
      prompt.note((error as Error).message);
    }
  }
}

async function chooseBlocks(prompt: PromptPort, schema: CmsSchema): Promise<string[]> {
  const names = Object.keys(schema.blocks);
  if (!names.length)
    throw new AddError("Add a reusable section first, then choose where it can appear.");
  const selected: string[] = [];
  while (true) {
    const name = await prompt.select(
      "Allowed section type",
      names
        .filter((n) => !selected.includes(n))
        .map((value) => ({ value, label: schema.blocks[value]?.label ?? value })),
    );
    selected.push(name);
    if (
      selected.length === names.length ||
      !(await prompt.confirm("Allow another section type?", false))
    )
      return selected;
  }
}

async function fieldsFor(prompt: PromptPort, schema: CmsSchema): Promise<FieldSpec[]> {
  const fields: FieldSpec[] = [];
  while (!fields.length || (await prompt.confirm("Add another field?", false))) {
    const name = await validText(
      prompt,
      "Field name",
      fields.length ? "description" : "title",
      (answer) => {
        parseFieldSpec(`${answer}:text`);
        if (fields.some((f) => f.name === answer)) throw new AddError("That field already exists.");
      },
    );
    const type = await prompt.select(
      "Field type",
      FIELD_TYPES.filter((t) => t.id !== "blocks" || Object.keys(schema.blocks).length).map(
        (t) => ({ value: t.id, label: labelFor(t.id) }),
      ),
    );
    const label = await prompt.text("Field label", labelFor(name));
    const required = await prompt.confirm("Required?", type === "text");
    const field: FieldSpec = { name, type, label, required };
    if (type === "group") {
      prompt.note(`Fields inside ${label}:`);
      field.fields = await fieldsFor(prompt, schema);
      prompt.note(`Finished ${label}. Back to the containing fields.`);
    }
    if (type === "text") {
      field.multiline = await prompt.confirm("Multiple lines?", false);
      field.default = await prompt.text("Default text (used before the first edit)", label);
    }
    if (type === "select") {
      const choices = await validText(
        prompt,
        "Choices, separated by |",
        "Primary|Secondary",
        (answer) => {
          const values = answer.split("|").map((v) => v.trim());
          if (values.length < 2 || values.some((v) => !v) || new Set(values).size !== values.length)
            throw new AddError("Enter at least two different, non-empty choices.");
        },
      );
      field.options = choices.split("|").map((v) => v.trim());
    }
    if (type === "list")
      field.of = await prompt.select(
        "List item type",
        FIELD_TYPES.filter((t) => !["list", "blocks", "select", "group"].includes(t.id)).map(
          (t) => ({
            value: t.id,
            label: labelFor(t.id),
          }),
        ),
      );
    if (type === "blocks") field.allow = await chooseBlocks(prompt, schema);
    fields.push(field);
  }
  return fields;
}

async function contentPlan(prompt: PromptPort, schema: CmsSchema): Promise<AddPlan | null> {
  const kind = await prompt.select("What should the CMS manage?", [
    {
      value: "region",
      label: "Editable region",
      hint: "a hero, contact details, or any field form",
    },
    { value: "block", label: "Reusable section", hint: "a component editors can add repeatedly" },
    {
      value: "sections",
      label: "Reorderable page sections",
      hint: "choose from your reusable sections",
    },
    { value: "collection", label: "Collection", hint: "products, pages, posts, team members…" },
    { value: "done", label: "Finish and review" },
  ]);
  if (kind === "done") return null;
  if (kind === "sections" && !Object.keys(schema.blocks).length)
    throw new AddError("Create a reusable section first.");
  const region = kind === "region" || kind === "sections";
  const name = await validText(
    prompt,
    region ? "Region ID" : "Name",
    region ? "home.intro" : kind === "block" ? "feature" : "products",
    (answer) => {
      const pattern = region ? /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/ : /^[a-z][a-z0-9-]*$/;
      if (!pattern.test(answer))
        throw new AddError(
          "Use lowercase letters, digits and hyphens; region IDs also allow dots.",
        );
      const entries = region
        ? schema.regions
        : kind === "block"
          ? schema.blocks
          : schema.collections;
      if (entries[answer]) throw new AddError("That name already exists. Choose a different name.");
    },
  );
  const label = await prompt.text("Editor label", labelFor(name));
  if (kind === "sections")
    return {
      kind: "region",
      id: name,
      label,
      fields: [],
      allow: await chooseBlocks(prompt, schema),
    };
  const fields = await fieldsFor(prompt, schema);
  if (kind === "region") return { kind, id: name, label, fields };
  if (kind === "block") return { kind, name, label, fields };
  const path = await validText(prompt, "Collection folder", `content/${name}`, (answer) => {
    if (
      !answer ||
      answer.startsWith("/") ||
      answer.includes("\\") ||
      answer.split("/").some((p) => !p || p === "." || p === "..") ||
      answer.startsWith(".cms")
    )
      throw new AddError("Use a relative folder inside the project, outside .cms.");
  });
  const format = await prompt.select<CollectionFormat>("Entry format", [
    { value: "json", label: "JSON" },
    { value: "markdown", label: "Markdown" },
    { value: "mdx", label: "MDX" },
  ]);
  let body: string | undefined;
  if (format !== "json") {
    const prose = fields.filter((f) => f.type === "richtext");
    if (prose.length)
      body = await prompt.select(
        "Body field",
        prose.map((f) => ({ value: f.name, label: f.label ?? f.name })),
      );
    else {
      body = await validText(prompt, "Markdown body field name", "body", (answer) => {
        parseFieldSpec(`${answer}:richtext`);
        if (fields.some((f) => f.name === answer))
          throw new AddError("That field name is already used.");
      });
      fields.push({ name: body, type: "richtext", required: false });
    }
  }
  const slugFields = fields.filter((f) => f.type === "text");
  const slug = slugFields.length
    ? await prompt.select(
        "Derive entry filenames from",
        slugFields.map((f) => ({ value: f.name, label: f.label ?? f.name })),
      )
    : undefined;
  const entryLabel = await prompt.text("Singular entry label", "Entry");
  return { kind: "collection", name, label, path, format, fields, body, slug, entryLabel };
}

interface Change {
  path: string;
  content: string;
  before: string | null;
}

async function writeChange(root: string, change: Change): Promise<void> {
  await safePath(root, change.path);
  const target = join(root, change.path);
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), ".greatcms-setup-"));
  try {
    const staged = join(staging, "file");
    await writeFile(staged, change.content);
    if ((await optionalRead(root, change.path)) !== change.before)
      throw new CliError(`${change.path} changed during setup.`);
    if (change.before === null) await link(staged, target);
    else await rename(staged, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function workingSchema(source: string): CmsSchema {
  const data = parseYaml(source);
  if (Object.keys(data.regions ?? {}).length || Object.keys(data.collections ?? {}).length)
    return parseSchema(source);
  // An unfinished model may contain only reusable blocks; the saved model may not.
  const schema = parseSchema(
    stringify({ ...data, regions: { "setup.internal": { fields: { title: { type: "text" } } } } }),
  );
  schema.regions = {};
  return schema;
}

function appendContent(source: string, path: string, plan: AddPlan): string {
  validatePlan(plan, workingSchema(source));
  const section = sectionFor(plan);
  const name = plan.kind === "region" ? plan.id : plan.name;
  const document = parseDocument(source);
  document.setIn([section, name], parseYaml(renderPlan(plan))[name]);
  const updated = path.endsWith(".json")
    ? `${JSON.stringify(document.toJS(), null, 2)}\n`
    : document.toString();
  workingSchema(updated);
  return updated;
}

export async function setupProject(options: {
  root: string;
  prompt: PromptPort;
  stdout: (text: string) => void;
}): Promise<number> {
  const { prompt, stdout } = options;
  if (!prompt.interactive)
    throw new CliError(
      "Setup needs an interactive terminal.",
      "For scripts, use greatcms init --yes --template <name> and greatcms add.",
    );
  let scan = await scanProject(options.root);
  prompt.note(
    `Scanned ${scan.root}\n${scan.detection.framework.label}: ${scan.detection.evidence}\n${scan.schema ? `Existing CMS: ${scan.schema.path}` : "No CMS schema found."}`,
  );
  if (scan.projects.length) {
    const target = await prompt.select("Project to set up", [
      { value: ".", label: "This directory" },
      ...scan.projects.map((value) => ({ value, label: value })),
    ]);
    if (target !== ".") {
      const child = await scanProject(join(scan.root, target), false);
      if (
        !child.packageJson?.packageManager &&
        !child.files.some((file) =>
          ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"].includes(
            file,
          ),
        )
      )
        child.manager = scan.manager;
      scan = child;
    }
  }
  const { root } = scan;
  let framework = scan.detection.framework;
  prompt.note(
    `${scan.schema ? "Extend existing CMS" : scan.packageJson ? "Add CMS to existing project" : "Create CMS project"}: ${root}\nFramework: ${framework.label} (${scan.detection.evidence})\nPackage manager: ${scan.manager}\nOnly configuration and package metadata were inspected; no project code was executed.`,
  );
  const changes: Change[] = [];
  let readerReady = false;
  let source = scan.schema?.source ?? "";
  const schemaPath = scan.schema?.path ?? ".cms/schema.yaml";
  if (!scan.schema) {
    const name = await prompt.text("Site name", scan.packageJson?.name ?? basename(root));
    if (!scan.detection.confident)
      framework = await prompt.select(
        "Site framework",
        Object.values(FRAMEWORKS).map((value) => ({ value, label: value.label })),
      );
    const template = await prompt.select("Starting point", [
      { value: "custom", label: "Build my own content model" },
      ...TEMPLATES.filter((t) => t.id !== "blank").map((t) => ({
        value: t.id,
        label: t.label,
        hint: t.hint,
      })),
    ]);
    const initial = planInit({
      name,
      framework,
      template:
        template === "custom" ? "blank" : (template as "hero" | "landing" | "business" | "blog"),
      regionsDir: framework.regionsDir,
      mediaDir: framework.mediaDir,
      mediaUrlPrefix: framework.mediaUrlPrefix,
      collectionsDir: framework.collectionsDir,
      schemaUrl: DEFAULT_SCHEMA_URL,
    });
    source =
      template === "custom" ? stringify({ version: 1, site: { name } }) : initial.files[0]!.content;
    if (!scan.config) {
      const configFile = initial.files[1]!;
      parseConfig(configFile.content, configFile.path);
      changes.push({ ...configFile, before: null });
    }
  }
  while (true) {
    const schema = workingSchema(source);
    prompt.note(
      `Content model: ${Object.keys(schema.regions).length} regions, ${Object.keys(schema.blocks).length} reusable sections, ${Object.keys(schema.collections).length} collections.`,
    );
    try {
      const plan = await contentPlan(prompt, schema);
      if (!plan) {
        if (!Object.keys(schema.regions).length && !Object.keys(schema.collections).length) {
          prompt.note("Add at least one editable region or collection before finishing.");
          continue;
        }
        break;
      }
      source = appendContent(source, schemaPath, plan);
      prompt.note(`Added ${plan.kind}: ${plan.kind === "region" ? plan.id : plan.name}`);
    } catch (error) {
      // One bad answer costs that answer, not everything modelled so far in this session.
      if (!(error instanceof AddError) && !(error instanceof SpecError)) throw error;
      prompt.note(error.message);
    }
  }
  if (source !== scan.schema?.source)
    changes.push({ path: schemaPath, content: source, before: scan.schema?.source ?? null });
  const schema = parseSchema(source, { file: schemaPath });
  if (
    await prompt.confirm(
      "Set up the build-time reader, generated types, and package scripts?",
      true,
    )
  ) {
    const pkg: PackageJson = structuredClone(
      scan.packageJson ?? {
        name: basename(root)
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-"),
        private: true,
        type: "module",
      },
    );
    pkg.devDependencies ??= {};
    const localPackages = fileURLToPath(new URL("../../", import.meta.url));
    const fromCheckout = await isGreatcmsCheckout(join(localPackages, ".."));
    for (const name of ["reader", "cli"]) {
      const key = `@greatcms/${name}`;
      if (pkg.dependencies?.[key] || pkg.devDependencies[key]) continue;
      const local = fromCheckout
        ? await readIfPresent(join(localPackages, name, "package.json"))
        : null;
      const isLocal =
        local !== null &&
        JSON.parse(local).name === key &&
        (await readIfPresent(join(localPackages, name, "dist/index.js"))) !== null;
      pkg.devDependencies[key] = isLocal
        ? `${scan.manager === "pnpm" || scan.manager === "yarn" ? "link" : "file"}:${join(localPackages, name)}`
        : "^0.1.0";
      if (isLocal)
        prompt.note(
          `${key}: linked to this local GreatCMS checkout. Keep it available, or replace the dependency when publishing.`,
        );
    }
    pkg.scripts ??= {};
    const typesPath = ".cms/types.d.ts";
    const oldTypes = await optionalRead(root, typesPath);
    const managedTypes =
      oldTypes === null || oldTypes.startsWith("// Generated by `greatcms types`");
    for (const [name, command] of Object.entries({
      "cms:check": "greatcms check",
      "cms:types": "greatcms types --out .cms/types.d.ts",
      "cms:setup": "greatcms setup",
    })) {
      if (name === "cms:types" && !managedTypes && !pkg.scripts[name]) {
        prompt.note(
          `Keeping custom ${typesPath}; cms:types was not added. Choose another output with greatcms types --out.`,
        );
        continue;
      }
      if (pkg.scripts[name] && pkg.scripts[name] !== command)
        prompt.note(`Keeping existing script ${name}: ${pkg.scripts[name]}`);
      else {
        pkg.scripts[name] = command;
        prompt.note(`${name}: ${command}`);
      }
    }
    const packageContent = `${JSON.stringify(pkg, null, 2)}\n`;
    if (packageContent !== scan.packageSource)
      changes.push({ path: "package.json", content: packageContent, before: scan.packageSource });
    const helper = ".cms/reader.mjs";
    const helperSource = [
      'import { existsSync } from "node:fs";',
      'import { fileURLToPath } from "node:url";',
      'import { createReader } from "@greatcms/reader";',
      "",
      "// Import from build or server code only, never from a browser bundle. Unbundled, this",
      "// file sits in .cms/; once a bundler moves it, the build's own folder holds .cms/ instead.",
      'const beside = fileURLToPath(new URL("../", import.meta.url));',
      "export const cms = createReader({",
      '  root: existsSync(new URL("../.cms", import.meta.url)) ? beside : process.cwd(),',
      "});",
      "",
    ].join("\n");
    const oldHelper = await optionalRead(root, helper);
    const outdated = oldHelper === LEGACY_READER_HELPER;
    readerReady = oldHelper === null || oldHelper === helperSource || outdated;
    if (oldHelper === null || outdated)
      changes.push({ path: helper, content: helperSource, before: oldHelper });
    else prompt.note(`Keeping existing ${helper}.`);
    const helperTypes = ".cms/reader.d.mts";
    if (readerReady && managedTypes && (await optionalRead(root, helperTypes)) === null)
      changes.push({
        path: helperTypes,
        content:
          'import "./types.js";\nimport type { CmsReader } from "@greatcms/reader";\nexport declare const cms: CmsReader;\n',
        before: null,
      });
    if (managedTypes) {
      const content = renderTypes(schema);
      if (content !== oldTypes) changes.push({ path: typesPath, content, before: oldTypes });
    } else
      prompt.note(
        `Keeping existing ${typesPath}; choose a different output with greatcms types --out.`,
      );
  }
  if (!changes.length) {
    stdout("Nothing to change.\n");
    return 0;
  }
  prompt.note(
    `Review changes in ${root}:\n${changes.map((c) => `  ${c.before === null ? "create" : "update"} ${c.path}`).join("\n")}\nExisting pages, framework config, content, and lockfiles will not be changed. No dependencies will be installed.`,
  );
  if (!(await prompt.confirm("Apply this setup?", true))) {
    stdout("Cancelled. Nothing was written.\n");
    return 0;
  }
  for (const change of changes) {
    if ((await optionalRead(root, change.path)) !== change.before)
      throw new CliError(
        `${change.path} changed during setup. Nothing was written. Run setup again.`,
      );
  }
  const written: Change[] = [];
  try {
    for (const change of changes) {
      await writeChange(root, change);
      written.push(change);
    }
  } catch (error) {
    for (const change of written.toReversed()) {
      if ((await optionalRead(root, change.path)) !== change.content) continue;
      if (change.before === null) await unlink(join(root, change.path));
      else
        await writeChange(root, {
          path: change.path,
          content: change.before,
          before: change.content,
        });
    }
    throw new CliError(`Setup could not finish: ${(error as Error).message}`);
  }
  stdout(
    `CMS ready in ${root}.\n${changes.some((c) => c.path === "package.json") ? `Next: cd ${JSON.stringify(root)} and run ${scan.manager} install, then ${scan.manager} run cms:check.\n` : "Run greatcms check to validate your content.\n"}Connect this folder in your local studio to edit it.\n${readerReady ? "Import cms from .cms/reader.mjs in build/server code and render your regions or collections in your existing pages." : "Read your content with @greatcms/reader in your site's build/server code."}\nNo website pages or studio server were generated. Run greatcms setup again to add more content models or select another workspace project.\n`,
  );
  return 0;
}
