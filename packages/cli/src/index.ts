/** @greatcms/cli — the local half of the workflow. */

import { access, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_CONFIG,
  DRAFT_DIR,
  parseConfig,
  parseSchema,
  regionFilePath,
  SpecError,
  type CmsConfig,
  type CollectionFormat,
  type CmsSchema,
} from "@greatcms/spec";
import {
  checkSite,
  formatReport,
  reportAsJson,
  type CheckPort,
  type CheckReport,
} from "./check.js";
import {
  AddError,
  applyPlan,
  FIELD_TYPES,
  labelFor,
  parseFieldSpec,
  readSnippet,
  type AddPlan,
  type FieldSpec,
} from "./add.js";
import { detectFramework, FRAMEWORKS, type Framework, type FrameworkId } from "./detect.js";
import { renderTypes } from "./types.js";
import {
  DEFAULT_SCHEMA_URL,
  nextSteps,
  planInit,
  TEMPLATES,
  type InitAnswers,
  type TemplateId,
} from "./init.js";
import { defaultsOnlyPrompt, PromptCancelled, terminalPrompt, type PromptPort } from "./prompt.js";
import { CliError, type FilePort, type GitPort } from "./ports.js";

const execFileAsync = promisify(execFile);

export function nodeGit(cwd: string): GitPort {
  return {
    async run(args: string[]): Promise<string> {
      try {
        const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
        return stdout;
      } catch (error) {
        const details = (error as { stderr?: string }).stderr?.trim();
        throw new CliError(
          `git ${args[0]} failed${details ? `: ${details}` : "."}`,
          args[0] === "fetch" ? "Check that the remote exists and you can reach it." : undefined,
        );
      }
    },
  };
}

export function nodeFiles(root: string): FilePort {
  return {
    async read(path: string) {
      try {
        return await readFile(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
    async write(path: string, content: string) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    },
    async remove(path: string) {
      await rm(join(root, path), { force: true });
    },
  };
}

/** Reading a site for `check`: no writes, and a missing directory is not news. */
export function nodeCheckFiles(root: string): CheckPort {
  return {
    async read(path: string) {
      try {
        return await readFile(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
    async list(dir: string) {
      try {
        const names = await readdir(join(root, dir), { withFileTypes: true });
        return names.filter((entry) => entry.isFile()).map((entry) => `${dir}/${entry.name}`);
      } catch {
        return [];
      }
    },
    async exists(path: string) {
      try {
        await access(join(root, path));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Content paths with an unsaved edit waiting in the working copy. */
async function listDrafts(root: string): Promise<string[]> {
  const walk = async (dir: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      return [];
    }
    const found = await Promise.all(
      entries.map(async (entry) => {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return walk(path);
        return entry.name === ".gitignore" ? [] : [path.slice(DRAFT_DIR.length + 1)];
      }),
    );
    return found.flat();
  };
  return walk(DRAFT_DIR);
}

export async function loadConfig(root: string): Promise<CmsConfig> {
  const found = await firstReadable(root, [
    ".cms/config.json",
    ".cms/config.yaml",
    ".cms/config.yml",
  ]);
  return found ? parseConfig(found.source, found.name) : DEFAULT_CONFIG;
}

export async function loadSchema(root: string): Promise<CmsSchema> {
  const found = await firstReadable(root, [
    ".cms/schema.json",
    ".cms/schema.yaml",
    ".cms/schema.yml",
  ]);
  if (!found) {
    throw new CliError(
      `No .cms/schema.yaml found in ${root}.`,
      "Run this from the root of a site managed by GreatCMS.",
    );
  }
  return parseSchema(found.source, { file: found.name });
}

/** Reads every candidate at once and keeps the first that exists, in order. */
async function firstReadable(
  root: string,
  names: string[],
): Promise<{ name: string; source: string } | null> {
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, source: await readFile(join(root, name), "utf8") };
      } catch {
        return null;
      }
    }),
  );
  return results.find((entry) => entry !== null) ?? null;
}

export interface RunOptions {
  argv: string[];
  cwd: string;
  /** Injected by tests so the interactive flow can be driven without a TTY. */
  prompt?: PromptPort;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function run(options: RunOptions): Promise<number> {
  const { argv, stdout, stderr } = options;
  const [command = "help", ...rest] = argv;
  const flags = parseFlags(rest);

  try {
    switch (command) {
      case "init":
        return await initCommand({ ...options, flags });
      case "add":
        return await addCommand({ ...options, flags, rest });
      case "check":
        return await checkCommand({ ...options, flags });
      case "types":
        return await typesCommand({ ...options, flags });
      case "doctor":
        return await doctorCommand({ ...options, flags });
      case "help":
      case "--help":
      case "-h":
        stdout(HELP);
        return 0;
      default:
        stderr(`Unknown command "${command}".\n\n${HELP}`);
        return 1;
    }
  } catch (error) {
    if (error instanceof PromptCancelled) return 130;
    if (error instanceof AddError || error instanceof CliError || error instanceof SpecError) {
      stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

export interface InitDeps {
  prompt?: PromptPort;
}

async function initCommand(options: RunOptions & { flags: Flags }): Promise<number> {
  const { cwd, stdout, flags } = options;
  const root = resolve(cwd);

  const prompt =
    options.prompt ??
    (flags.boolean("yes") || !process.stdin.isTTY
      ? defaultsOnlyPrompt(stdout)
      : terminalPrompt({ input: process.stdin, output: process.stdout }));

  const existing = await Promise.all(
    [".cms/schema.yaml", ".cms/config.yaml"].map(async (name) => ({
      name,
      exists: (await nodeFiles(root).read(name)) !== null,
    })),
  );
  const clashes = existing.filter((file) => file.exists).map((file) => file.name);
  if (clashes.length > 0 && !flags.boolean("force")) {
    throw new CliError(
      `This repository is already set up: ${clashes.join(", ")}.`,
      "Edit those files directly, run `greatcms doctor` to check them, or pass --force to start over.",
    );
  }

  const detection = detectFramework({
    files: await listRoot(root),
    packageJson: await readPackageJson(root),
  });

  stdout(`\nSetting up GreatCMS in ${root}\n\n`);
  prompt.note(
    detection.confident
      ? `Detected ${detection.framework.label} (${detection.evidence}).`
      : `No framework detected (${detection.evidence}).`,
  );

  const name =
    flags.string("name") ??
    (await prompt.text("Site name?", (await readPackageName(root)) ?? basename(root)));

  const framework = flags.string("framework")
    ? frameworkFromFlag(flags.string("framework") as string)
    : await prompt.select<Framework>(
        "What is this site built with?",
        Object.values(FRAMEWORKS).map((entry) => ({
          value: entry,
          label: entry.label,
          hint: entry.id === detection.framework.id ? "detected" : undefined,
        })),
        Object.values(FRAMEWORKS).findIndex((entry) => entry.id === detection.framework.id),
      );

  const template = flags.string("template")
    ? templateFromFlag(flags.string("template") as string)
    : await prompt.select<TemplateId>(
        "What should the CMS manage to begin with?",
        TEMPLATES.map((entry) => ({ value: entry.id, label: entry.label, hint: entry.hint })),
      );

  const regionsDir =
    flags.string("dir") ??
    (await prompt.text("Where should content files live?", framework.regionsDir));

  const branch = flags.string("branch") ?? (await currentBranch(root)) ?? "main";

  const answers: InitAnswers = {
    name,
    framework,
    template,
    regionsDir,
    mediaDir: framework.mediaDir,
    mediaUrlPrefix: framework.mediaUrlPrefix,
    collectionsDir: framework.collectionsDir,
    branch,
    schemaUrl: DEFAULT_SCHEMA_URL,
  };

  const plan = planInit(answers);
  const files = nodeFiles(root);
  await Promise.all(plan.files.map((file) => files.write(file.path, file.content)));

  stdout(nextSteps(answers, plan));
  return 0;
}

/**
 * `greatcms add` — the step between `init` and having a site. Everything it
 * writes could be typed into the schema by hand; the point is that the YAML
 * indentation, the field syntax, and the file path are no longer yours to get
 * right.
 */
async function addCommand(options: RunOptions & { flags: Flags; rest: string[] }): Promise<number> {
  const { cwd, stdout, flags, rest } = options;
  const root = resolve(cwd);

  const kind = rest[0];
  if (kind !== "region" && kind !== "block" && kind !== "collection") {
    throw new AddError(
      kind ? `Cannot add a "${kind}".` : "Say what to add.",
      "greatcms add region <id> | add block <name> | add collection <name>",
    );
  }

  const name = rest[1] && !rest[1].startsWith("--") ? rest[1] : undefined;

  const prompt =
    options.prompt ??
    (flags.boolean("yes") || !process.stdin.isTTY
      ? defaultsOnlyPrompt(stdout)
      : terminalPrompt({ input: process.stdin, output: process.stdout }));

  const found = await firstReadable(root, [
    ".cms/schema.json",
    ".cms/schema.yaml",
    ".cms/schema.yml",
  ]);
  if (!found) {
    throw new AddError(
      `No .cms/schema.yaml found in ${root}.`,
      "Run `greatcms init` first, or run this from the root of the site.",
    );
  }

  const config = await loadConfig(root);
  const id = name ?? (await prompt.text(`What is the ${kind} called?`, suggestedName(kind)));
  const label = flags.string("label") ?? labelFor(id);

  // --field can appear several times; the flag parser keeps the last, so the raw
  // argument list is the honest source for a repeated flag.
  const fieldArgs = repeatedFlag(rest, "field");
  const allow = flags
    .string("blocks")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const fields =
    fieldArgs.length > 0
      ? fieldArgs.map(parseFieldSpec)
      : allow
        ? []
        : await askForFields(prompt, kind);

  if (fields.length === 0 && !allow) {
    throw new AddError(
      `A ${kind} with no fields would give an editor nothing to edit.`,
      "Add one with --field, e.g. --field heading:text!",
    );
  }

  const plan: AddPlan =
    kind === "region"
      ? { kind: "region", id, label, fields, ...(allow ? { allow } : {}) }
      : kind === "block"
        ? { kind: "block", name: id, label, fields }
        : {
            kind: "collection",
            name: id,
            label,
            path: flags.string("dir") ?? `${defaultCollectionsDir(root, config)}/${id}`,
            format: collectionFormat(flags.string("format")),
            body: fields.find((field) => field.type === "richtext")?.name,
            fields,
          };

  const result = applyPlan({ plan, source: found.source, file: found.name, config });
  await nodeFiles(root).write(found.name, result.schema);

  const detection = detectFramework({
    files: await listRoot(root),
    packageJson: await readPackageJson(root),
  });
  const snippet = readSnippet(plan, detection.framework, config);

  const lines = ["", `Added ${kind} ${id} to ${found.name}.`, ""];
  if (result.contentPath) {
    lines.push(
      plan.kind === "region"
        ? `It renders its defaults now, and the studio writes ${result.contentPath} the first time someone edits it.`
        : `Entries land in ${result.contentPath}/.`,
      "",
    );
  }
  if (snippet) {
    lines.push(
      `Read it in your ${detection.framework.label} templates:`,
      "",
      indentBlock(snippet),
      "",
    );
  }
  lines.push("  greatcms check     confirm the content still matches the schema", "");

  stdout(lines.join("\n"));
  return 0;
}

/** One question per field, until the answer is empty. */
async function askForFields(prompt: PromptPort, kind: string): Promise<FieldSpec[]> {
  if (!prompt.interactive) {
    throw new AddError(
      `This ${kind} needs at least one field.`,
      "Pass them with --field, e.g. --field heading:text! --field body:richtext",
    );
  }

  prompt.note(
    `Add fields one at a time, as name:type. Types: ${FIELD_TYPES.map((entry) => entry.id).join(", ")}.\nA trailing ! means required. Leave it empty to finish.`,
  );

  const fields: FieldSpec[] = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a person answers one question at a time
    const answer = (await prompt.text(`Field ${fields.length + 1}?`, "")).trim();
    if (answer === "") break;
    try {
      fields.push(parseFieldSpec(answer));
    } catch (error) {
      prompt.note((error as Error).message);
    }
  }
  return fields;
}

function suggestedName(kind: string): string {
  return kind === "region" ? "home.hero" : kind === "block" ? "feature" : "blog";
}

function collectionFormat(value: string | undefined): CollectionFormat {
  if (value === undefined) return "markdown";
  if (value === "markdown" || value === "mdx" || value === "json") return value;
  throw new AddError(`Unknown collection format "${value}".`, "Use markdown, mdx, or json.");
}

function defaultCollectionsDir(root: string, config: CmsConfig): string {
  const regions = config.content.regions.replace(/\/+$/, "");
  // Collections sit beside regions rather than inside them: they are separate content.
  return regions.includes("/") ? regions.slice(0, regions.lastIndexOf("/")) : "content";
}

/** Every occurrence of `--name value`, because some flags are meant to repeat. */
export function repeatedFlag(argv: string[], name: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== `--${name}`) continue;
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) found.push(value);
  }
  return found;
}

function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}

async function listRoot(root: string): Promise<string[]> {
  try {
    return await readdir(root);
  } catch {
    return [];
  }
}

async function readPackageJson(root: string): Promise<Record<string, never> | undefined> {
  try {
    return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

async function readPackageName(root: string): Promise<string | undefined> {
  const pkg = (await readPackageJson(root)) as { name?: string } | undefined;
  return pkg?.name?.replace(/^@[^/]+\//, "");
}

async function currentBranch(root: string): Promise<string | null> {
  try {
    return (await nodeGit(root).run(["rev-parse", "--abbrev-ref", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

function frameworkFromFlag(value: string): Framework {
  const framework = FRAMEWORKS[value as FrameworkId];
  if (!framework) {
    throw new CliError(
      `Unknown framework "${value}".`,
      `Choose one of: ${Object.keys(FRAMEWORKS).join(", ")}.`,
    );
  }
  return framework;
}

function templateFromFlag(value: string): TemplateId {
  const template = TEMPLATES.find((entry) => entry.id === value);
  if (!template) {
    throw new CliError(
      `Unknown template "${value}".`,
      `Choose one of: ${TEMPLATES.map((entry) => entry.id).join(", ")}.`,
    );
  }
  return template.id;
}

/** Exits non-zero when the content would not render, so a build can run it. */
async function checkCommand(options: RunOptions & { flags: Flags }): Promise<number> {
  const { cwd, stdout, stderr, flags } = options;
  const root = resolve(cwd);

  const report: CheckReport = await checkSite({
    schema: await loadSchema(root),
    config: await loadConfig(root),
    files: nodeCheckFiles(root),
  });

  if (flags.boolean("json")) {
    stdout(reportAsJson(report));
    return report.issues.length === 0 ? 0 : 1;
  }

  if (report.issues.length === 0) {
    stdout(formatReport(report));
    return 0;
  }

  stderr(formatReport(report));
  return 1;
}

/** Types for the schema, so a schema change is a compile error, not a blank page. */
async function typesCommand(options: RunOptions & { flags: Flags }): Promise<number> {
  const { cwd, stdout, flags } = options;
  const root = resolve(cwd);
  const schema = await loadSchema(root);
  const source = renderTypes(schema, { module: flags.string("module") });

  const out = flags.string("out");
  if (!out) {
    stdout(source);
    return 0;
  }

  // Committed types that no longer match the schema are worse than none: they
  // describe a site that does not exist, and nothing complains.
  if (flags.boolean("check")) {
    const current = await nodeFiles(root).read(out);
    if (current === source) {
      stdout(`${out} is up to date.\n`);
      return 0;
    }
    options.stderr(
      `${out} does not match .cms/schema.yaml.\n` +
        `  fix: run \`greatcms types --out ${out}\` and commit the result.\n`,
    );
    return 1;
  }

  await nodeFiles(root).write(out, source);
  const counts = [
    `${Object.keys(schema.regions).length} regions`,
    `${Object.keys(schema.blocks).length} blocks`,
    `${Object.keys(schema.collections).length} collections`,
  ];
  stdout(
    `\nWrote ${out} (${counts.join(", ")}).\n\n` +
      `Include it in your tsconfig and \`cms.region("home.hero")\` is typed by its id.\n` +
      `Regenerate it when the schema changes — in a build script, or in CI with --check.\n\n`,
  );
  return 0;
}

async function doctorCommand(options: RunOptions & { flags: Flags }): Promise<number> {
  const { cwd, stdout } = options;
  const root = resolve(cwd);
  const config = await loadConfig(root);
  const schema = await loadSchema(root);
  const files = nodeFiles(root);

  const lines: string[] = ["GreatCMS setup looks like this:", ""];
  lines.push(`  spec version   ${schema.version}`);
  lines.push(`  regions dir    ${config.content.regions}`);
  lines.push(`  publish branch ${config.publish.branch}`);
  lines.push();
  lines.push("", `Regions (${Object.keys(schema.regions).length}):`);

  const statuses = await Promise.all(
    Object.keys(schema.regions).map(async (regionId) => {
      const path = regionFilePath(config, regionId);
      return { regionId, path, exists: (await files.read(path)) !== null };
    }),
  );

  let unedited = 0;
  for (const { regionId, path, exists } of statuses) {
    if (!exists) unedited += 1;
    lines.push(`  ${exists ? "edited " : "default"} ${regionId}  →  ${path}`);
  }

  if (unedited > 0) {
    lines.push(
      "",
      `${unedited} region${unedited === 1 ? "" : "s"} ${unedited === 1 ? "has" : "have"} no content file yet, and will render schema defaults. That is normal, not a problem.`,
    );
  }

  const collections = Object.keys(schema.collections);
  if (collections.length > 0) {
    lines.push("", `Collections: ${collections.join(", ")}`);
  }

  // An unsaved draft only shows in dev, so the only way to notice a forgotten
  // one is to be told.
  const drafts = await listDrafts(root);
  if (drafts.length > 0) {
    lines.push(
      "",
      `${drafts.length} unsaved edit${drafts.length === 1 ? "" : "s"} in ${DRAFT_DIR}, which your dev server is showing instead of what is published:`,
      ...drafts.map((path) => `  ${path}`),
      `  fix: publish it in the studio, or delete ${DRAFT_DIR} to go back to what is committed.`,
    );
  }

  stdout(`${lines.join("\n")}\n`);
  return 0;
}

interface Flags {
  string(name: string): string | undefined;
  boolean(name: string): boolean;
}

export function parseFlags(argv: string[]): Flags {
  const values = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      values.set(name, next);
      i += 1;
    } else {
      values.set(name, true);
    }
  }
  return {
    string: (name) => {
      const value = values.get(name);
      return typeof value === "string" ? value : undefined;
    },
    boolean: (name) => values.has(name),
  };
}

const HELP = `greatcms — local tools for a Git-backed site

  greatcms init [options]        set up .cms/schema.yaml and .cms/config.yaml
    --yes                        accept every default, no prompts
    --name <name>                site name
    --framework <id>             astro | next | nuxt | sveltekit | eleventy | generic
    --template <id>              hero | landing | blog | blank
    --dir <path>                 where content files live
    --branch <name>              publish branch (default: current branch)
    --force                      overwrite an existing setup

  greatcms add region <id>       add a managed section to an existing schema
  greatcms add block <name>      add a block type a blocks region can hold
  greatcms add collection <name> add a folder of entries
    --field name:type            repeatable. text richtext image link number
                                 boolean date file, select(a|b), list(text);
                                 a trailing ! means required
    --label "<text>"             what an editor sees (default: from the id)
    --blocks a,b                 make the region a reorderable list of blocks
    --format markdown|json       collections only (default: markdown)
    --dir <path>                 collections only, where entries live

  greatcms check [--json]        validate this repository's content against the
                                 schema; exits non-zero, so CI can run it

  greatcms types [--out <path>]  TypeScript for every region, block, and
                                 collection, plus the augmentation that types
                                 cms.region() by its id. Prints to stdout
                                 without --out.
    --check                      exit non-zero if the file is out of date,
                                 so CI catches types that drifted
    --module <specifier>         module the augmentation targets

  greatcms doctor                check this repository's CMS setup

Everything here runs on your machine, with your toolchain. Nothing from this
repository is ever executed by the studio.
`;
