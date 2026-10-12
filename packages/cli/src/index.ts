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
  blocksRegionIds,
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
  mergeAgentsNote,
} from "./init.js";
import { defaultsOnlyPrompt, PromptCancelled, terminalPrompt, type PromptPort } from "./prompt.js";
import { CliError, type FilePort, type GitPort } from "./ports.js";
import { setupProject } from "./setup.js";

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
  const found = await schemaSourceOf(root);
  return parseSchema(found.source, { file: found.name });
}

async function schemaSourceOf(root: string): Promise<{ name: string; source: string }> {
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
  return found;
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

/** Prompts need a person on both ends: keys coming in, and a screen to redraw. */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function run(options: RunOptions): Promise<number> {
  const { argv, stdout, stderr } = options;
  const [command = "help", ...rest] = argv;
  const flags = parseFlags(rest);
  const knownCommand = ["setup", "init", "add", "check", "types", "doctor"].includes(command);

  // Help must be side-effect free even when it follows a mutating command.
  if (knownCommand && (rest.includes("--help") || rest.includes("-h"))) {
    stdout(HELP);
    return 0;
  }

  try {
    if (knownCommand && command !== "setup" && flags.unknown.length > 0) {
      throw new CliError(
        `Unknown option ${flags.unknown.join(", ")}.`,
        `Run \`greatcms ${command} --help\` to see the options it takes.`,
      );
    }
    switch (command) {
      case "setup": {
        if (rest.length > 1 || rest.some((arg) => arg.startsWith("-")))
          throw new CliError("Usage: greatcms setup [directory]");
        const prompt =
          options.prompt ??
          (isInteractive()
            ? terminalPrompt({ input: process.stdin, output: process.stdout })
            : defaultsOnlyPrompt(stdout));
        return await setupProject({ root: resolve(options.cwd, rest[0] ?? "."), prompt, stdout });
      }
      case "init":
        if (!rest.length && (options.prompt?.interactive || isInteractive())) {
          return await setupProject({
            root: options.cwd,
            prompt:
              options.prompt ?? terminalPrompt({ input: process.stdin, output: process.stdout }),
            stdout,
          });
        }
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
    if (error instanceof PromptCancelled) {
      stderr("\nCancelled. Nothing was written.\n");
      return 130;
    }
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
    (flags.boolean("yes") || !isInteractive()
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
  const frameworkFlag = flags.string("framework");
  const chosenFramework = frameworkFlag ? frameworkFromFlag(frameworkFlag) : null;

  stdout(`\nSetting up GreatCMS in ${root}\n\n`);
  prompt.note(
    chosenFramework
      ? `Using ${chosenFramework.label} (--framework).`
      : detection.confident
        ? `Detected ${detection.framework.label} (${detection.evidence}).`
        : `No framework detected (${detection.evidence}).`,
  );

  const name =
    flags.string("name") ??
    (await prompt.text("Site name?", (await readPackageName(root)) ?? basename(root)));

  const framework = chosenFramework
    ? chosenFramework
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

  const answers: InitAnswers = {
    name,
    framework,
    template,
    regionsDir,
    mediaDir: framework.mediaDir,
    mediaUrlPrefix: framework.mediaUrlPrefix,
    collectionsDir: framework.collectionsDir,
    schemaUrl: DEFAULT_SCHEMA_URL,
  };

  const plan = planInit(answers);
  const files = nodeFiles(root);
  await Promise.all(plan.files.map((file) => files.write(file.path, file.content)));
  // The agent that works in this repository next should not have to discover any of this.
  await files.write("AGENTS.md", mergeAgentsNote(await files.read("AGENTS.md"), plan.agentsNote));

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

  const [requestedKind, name] = flags.positionals;
  if (
    requestedKind !== "region" &&
    requestedKind !== "section" &&
    requestedKind !== "block" &&
    requestedKind !== "collection"
  ) {
    throw new AddError(
      requestedKind ? `Cannot add a "${requestedKind}".` : "Say what to add.",
      "greatcms add region <id> | add section <name> | add collection <name>",
    );
  }
  const kind = requestedKind === "section" ? "block" : requestedKind;

  const prompt =
    options.prompt ??
    (flags.boolean("yes") || !isInteractive()
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
  const schema = parseSchema(found.source, { file: found.name });

  const config = await loadConfig(root);
  const id =
    name ??
    (await prompt.text(`What is the ${requestedKind} called?`, suggestedName(requestedKind)));
  const label = flags.string("label") ?? labelFor(id);

  if (flags.string("to") && kind !== "block") {
    throw new AddError(
      `--to does not apply to a ${requestedKind}.`,
      "Use it with `greatcms add section <name> --to <blocks-region>`.",
    );
  }

  let target = flags.string("to");
  if (requestedKind === "section" && !target) {
    const destinations = blocksRegionIds(schema);
    if (destinations.length === 1) {
      target = destinations[0];
    } else if (destinations.length === 0) {
      throw new AddError(
        "This schema has no reorderable page region for the section.",
        "Add one first: greatcms add region home.sections --blocks feature",
      );
    } else if (prompt.interactive) {
      target = await prompt.select(
        "Where should editors be able to add it?",
        destinations.map((value) => ({
          value,
          label: schema.regions[value]?.label ?? labelFor(value),
          hint: value,
        })),
      );
    } else {
      throw new AddError(
        "This schema has more than one reorderable page region.",
        `Choose one with --to: ${destinations.join(", ")}.`,
      );
    }
  }

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
        ? { kind: "block", name: id, label, fields, ...(target ? { to: target } : {}) }
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

  const lines = ["", `Added ${requestedKind} ${id} to ${found.name}.`, ""];
  if (plan.kind === "block" && plan.to) {
    lines.push(`Editors can now add it in ${plan.to}.`, "");
    if (requestedKind === "section") {
      lines.push(
        `Implement the \`_type: "${id}"\` case once in your site's section renderer.`,
        "After that, editors can add and reuse it without another schema change.",
        "",
      );
    }
  } else if (plan.kind === "block") {
    lines.push(
      "This block is defined for nested use, but is not in a page region yet.",
      "Add its name to a blocks region's `allow` list when it should be selectable there.",
      "",
    );
  }
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
    const token = argv[i];
    if (token?.startsWith(`--${name}=`)) {
      found.push(token.slice(name.length + 3));
      continue;
    }
    if (token !== `--${name}`) continue;
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

  const schemaSource = await schemaSourceOf(root);
  const report: CheckReport = await checkSite({
    schema: parseSchema(schemaSource.source, { file: schemaSource.name }),
    config: await loadConfig(root),
    files: nodeCheckFiles(root),
    schemaSource,
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
    if (flags.boolean("check")) {
      // Without a file there is nothing to compare, and a check that cannot fail is no check.
      throw new CliError("`greatcms types --check` needs `--out <file>` to compare against.");
    }
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
  const { cwd, stdout, flags } = options;
  const root = resolve(cwd);
  const config = await loadConfig(root);
  const schema = await loadSchema(root);
  const files = nodeFiles(root);

  const lines: string[] = ["GreatCMS setup looks like this:", ""];
  lines.push(`  spec version   ${schema.version}`);
  lines.push(`  regions dir    ${config.content.regions}`);
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
  if (flags.boolean("json")) {
    stdout(
      `${JSON.stringify(
        {
          specVersion: schema.version,
          regionsDir: config.content.regions,
          mediaDir: config.content.media,
          regions: statuses.map(({ regionId, path, exists }) => ({
            id: regionId,
            path,
            edited: exists,
          })),
          collections: Object.entries(schema.collections).map(([name, collection]) => ({
            name,
            path: collection.path,
            format: collection.format,
          })),
          drafts,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
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
  /** Arguments that are not flags or flag values, in order. */
  positionals: string[];
  /** Flags no command understands, so a typo is reported rather than ignored. */
  unknown: string[];
}

/** Switches never take a value, so `--yes hero.banner` leaves the name where it was typed. */
const SWITCHES = new Set(["yes", "force", "check", "json", "help"]);
const OPTIONS = new Set([
  "name",
  "framework",
  "template",
  "dir",
  "format",
  "label",
  "module",
  "out",
  "to",
  "field",
]);

export function parseFlags(argv: string[]): Flags {
  const values = new Map<string, string | true>();
  const positionals: string[] = [];
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) {
      if (token !== "-h") positionals.push(token);
      continue;
    }
    const [name = "", inline] = token.slice(2).split(/=(.*)/s, 2);
    if (SWITCHES.has(name)) {
      values.set(name, true);
    } else if (OPTIONS.has(name)) {
      const next = argv[i + 1];
      if (inline !== undefined) {
        values.set(name, inline);
      } else if (next !== undefined && !next.startsWith("--")) {
        values.set(name, next);
        i += 1;
      } else {
        values.set(name, true);
      }
    } else {
      unknown.push(token);
    }
  }
  return {
    string: (name) => {
      const value = values.get(name);
      return typeof value === "string" ? value : undefined;
    },
    boolean: (name) => values.has(name),
    positionals,
    unknown,
  };
}

const HELP = `greatcms — local tools for a Git-backed site

  greatcms setup [directory]     scan a new/existing project or workspace, build
                                 custom regions, sections and collections,
                                 then review and apply CMS integration

  greatcms init [options]        set up .cms/schema.yaml and .cms/config.yaml
    --yes                        accept every default, no prompts
    --name <name>                site name
    --framework <id>             astro | next | nuxt | sveltekit | eleventy | generic
    --template <id>              hero | landing | business | blog | blank
    --dir <path>                 where content files live
    --force                      overwrite an existing setup

  greatcms add region <id>       add a managed section to an existing schema
  greatcms add section <name>    define a reusable page section and make it
                                 selectable in a reorderable region
  greatcms add block <name>      add a block type a blocks region can hold
  greatcms add collection <name> add a folder of entries
    --field name:type            repeatable. text richtext image link number
                                 boolean date file, select(a|b), list(text);
                                 a trailing ! means required
    --label "<text>"             what an editor sees (default: from the id)
    --to <region>                destination for a section; optional for a block
    --blocks a,b                 make the region a reorderable list of blocks
    --format markdown|mdx|json   collections only (default: markdown)
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

  greatcms doctor [--json]       check this repository's CMS setup; --json for
                                 a machine-readable summary

Everything here runs on your machine, with your toolchain. Nothing from this
repository is ever executed by the studio.
`;
