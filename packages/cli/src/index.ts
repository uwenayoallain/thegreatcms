/** @greatcms/cli: the local half of the workflow. */

import { describeSite, formatDescription } from "./describe.js";
import { access, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_CONFIG,
  DRAFT_DIR,
  entryExtension,
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
  type Connection,
  type InitAnswers,
  type TemplateId,
  mergeAgentsNote,
} from "./init.js";
import { packageManager, wirePreview, withReader } from "./wire.js";
import { defaultsOnlyPrompt, PromptCancelled, terminalPrompt, type PromptPort } from "./prompt.js";
import { CliError, UsageError, type FilePort, type GitPort } from "./ports.js";
import {
  commandHelp,
  completionScript,
  crashText,
  findCommand,
  overviewHelp,
  parseFlags,
  unknownCommand,
  validate,
  versionText,
  type Flags,
} from "./commands.js";
import { setupProject } from "./setup.js";
import { plainUi, ui, useUi, type Ui } from "./ui.js";

export { createUi, wantsColour, type Ui } from "./ui.js";
export { parseFlags, type Flags } from "./commands.js";
export { VERSION } from "./version.js";

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
  /** Colour and marks; the binary passes one that knows its terminal, anything else gets plain text. */
  ui?: Ui;
}

/** Prompts need a person on both ends: keys coming in, and a screen to redraw. */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function run(options: RunOptions): Promise<number> {
  const { stdout, stderr } = options;
  // A global switch, honoured wherever it is typed, so it is taken out before anything else reads argv.
  const plain = options.argv.includes("--no-color");
  const argv = options.argv.filter((arg) => arg !== "--no-color");
  useUi(plain ? plainUi : (options.ui ?? plainUi));
  const [command = "help", ...rest] = argv;

  try {
    if (["--version", "-v", "-V", "version"].includes(command)) {
      stdout(versionText());
      return 0;
    }
    if (command === "--help" || command === "-h") {
      stdout(overviewHelp());
      return 0;
    }
    if (command.startsWith("-")) {
      throw new UsageError(
        `Unknown option ${command}.`,
        "Options go after the command. Run `greatcms --help` to see the commands.",
      );
    }
    const spec = findCommand(command);
    if (!spec) throw unknownCommand(command);
    const flags = parseFlags(rest);

    // Help and the version are side-effect free, even after a mutating command.
    if (flags.boolean("help")) {
      stdout(commandHelp(spec));
      return 0;
    }
    if (flags.boolean("version")) {
      stdout(versionText());
      return 0;
    }
    validate(spec, flags);

    switch (spec.name) {
      case "setup": {
        const prompt =
          options.prompt ??
          (isInteractive()
            ? terminalPrompt({ input: process.stdin, output: process.stdout })
            : defaultsOnlyPrompt(stdout));
        return await setupProject({
          root: resolve(options.cwd, flags.positionals[0] ?? "."),
          prompt,
          stdout,
        });
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
        return await addCommand({ ...options, flags });
      case "check":
        return await checkCommand({ ...options, flags });
      case "types":
        return await typesCommand({ ...options, flags });
      case "doctor":
        return await doctorCommand({ ...options, flags });
      case "describe":
        return await describeCommand({ ...options, flags });
      case "studio": {
        const { studioCommand } = await import("./studio.js");
        const prompt =
          options.prompt ??
          (isInteractive()
            ? terminalPrompt({ input: process.stdin, output: process.stdout })
            : undefined);
        return await studioCommand({ cwd: options.cwd, flags, stdout, stderr, prompt });
      }
      case "completion": {
        const [shell] = flags.positionals;
        if (!shell) {
          throw new UsageError("Say which shell.", "greatcms completion bash | zsh | fish");
        }
        stdout(completionScript(shell));
        return 0;
      }
      default: {
        const [topic] = flags.positionals;
        stdout(topic ? commandHelp(findCommand(topic)!) : overviewHelp());
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof PromptCancelled) {
      stderr(`\n${ui().warn("Cancelled. Nothing was written.")}\n`);
      return 130;
    }
    if (error instanceof AddError || error instanceof CliError || error instanceof SpecError) {
      stderr(`${ui().err(error.message)}\n`);
      return error instanceof UsageError ? 2 : 1;
    }
    // A failure from the system, such as a folder it may not write to, is the person's to fix.
    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") {
      stderr(`${ui().err(error.message)}\n`);
      return 1;
    }
    stderr(crashText(error, Boolean(process.env.GREATCMS_DEBUG)));
    return 1;
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
  const chosenFramework = frameworkFlag ? FRAMEWORKS[frameworkFlag as FrameworkId] : null;

  stdout(`\n${ui().step("Setting up GreatCMS")}\n${ui().note(root)}\n\n`);
  prompt.note(
    ui().info(
      chosenFramework
        ? `Using ${chosenFramework.label} (--framework).`
        : detection.confident
          ? `Detected ${detection.framework.label} (${detection.evidence}).`
          : `No framework detected (${detection.evidence}).`,
    ),
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
    ? (flags.string("template") as TemplateId)
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

  stdout(nextSteps(answers, plan, await connect(root, framework, prompt, flags)));
  return 0;
}

/**
 * Adds the reader to package.json and the live preview to the framework's own
 * config, after asking. Every edit is one additive line; a file that is not a
 * shape we recognise is left alone and listed for a person instead.
 */
async function connect(
  root: string,
  framework: Framework,
  prompt: PromptPort,
  flags: Flags,
): Promise<Connection> {
  const files = nodeFiles(root);
  const packageSource = await files.read("package.json");
  const manager = packageManager(
    await listRoot(root),
    packageSource ? (JSON.parse(packageSource) as { packageManager?: unknown }) : undefined,
  );
  if (flags.boolean("no-wire")) return { edited: [], manual: [], manager, packageEdited: false };
  const packageContent = packageSource ? withReader(packageSource) : null;
  const wiring = await wirePreview(framework.id, (path) => files.read(path));
  const edits = [
    ...(packageContent ? [{ path: "package.json", content: packageContent }] : []),
    ...wiring.edits,
  ];
  if (
    edits.length &&
    !(await prompt.confirm(
      `Add the reader and the live preview? (edits ${edits.map((edit) => edit.path).join(", ")})`,
      true,
    ))
  )
    return { edited: [], manual: wiring.manual, manager, packageEdited: false };
  await Promise.all(edits.map((edit) => files.write(edit.path, edit.content)));
  return {
    edited: wiring.edits.map((edit) => edit.path),
    manual: wiring.manual,
    manager,
    packageEdited: packageContent !== null,
  };
}

/**
 * `greatcms add`: the step between `init` and having a site. Everything it
 * writes could be typed into the schema by hand; the point is that the YAML
 * indentation, the field syntax, and the file path are no longer yours to get
 * right.
 */
async function addCommand(options: RunOptions & { flags: Flags }): Promise<number> {
  const { cwd, stdout, flags } = options;
  const root = resolve(cwd);

  const [requestedKind, name] = flags.positionals;
  if (
    requestedKind !== "region" &&
    requestedKind !== "section" &&
    requestedKind !== "block" &&
    requestedKind !== "collection"
  ) {
    throw new UsageError(
      "Say what to add.",
      "greatcms add region <id> | add section <name> | add block <name> | add collection <name>",
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

  const fieldArgs = flags.strings("field");
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

  const lines = ["", ui().ok(`Added ${requestedKind} ${ui().bold(id)} to ${found.name}.`), ""];
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
  lines.push(
    `  ${ui().accent("greatcms check")}     confirm the content still matches the schema`,
    "",
  );

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
  return (value as CollectionFormat | undefined) ?? "markdown";
}

function defaultCollectionsDir(root: string, config: CmsConfig): string {
  const regions = config.content.regions.replace(/\/+$/, "");
  // Collections sit beside regions rather than inside them: they are separate content.
  return regions.includes("/") ? regions.slice(0, regions.lastIndexOf("/")) : "content";
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
      stdout(`${ui().ok(`${out} is up to date.`)}\n`);
      return 0;
    }
    options.stderr(
      `${ui().err(
        `${out} does not match .cms/schema.yaml.\n  fix: run \`greatcms types --out ${out}\` and commit the result.`,
      )}\n`,
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
    `\n${ui().ok(`Wrote ${out} (${counts.join(", ")}).`)}\n\n` +
      `${ui().note(
        `Include it in your tsconfig and \`cms.region("home.hero")\` is typed by its id.\n` +
          `Regenerate it when the schema changes: in a build script, or in CI with --check.`,
      )}\n\n`,
  );
  return 0;
}

async function describeCommand(options: RunOptions & { flags: Flags }): Promise<number> {
  const { cwd, stdout, flags } = options;
  const root = resolve(cwd);
  const config = await loadConfig(root);
  const schema = await loadSchema(root);
  const files = nodeCheckFiles(root);
  const [edited, entries] = await Promise.all([
    Promise.all(
      Object.keys(schema.regions).map(async (id) =>
        (await files.read(regionFilePath(config, id))) === null ? null : id,
      ),
    ),
    Promise.all(
      Object.entries(schema.collections).map(async ([name, collection]) => {
        const extension = `.${entryExtension(collection.format)}`;
        const dir = collection.path.replace(/\/+$/, "");
        const paths = await files.list(dir);
        return [
          name,
          paths
            .filter((path) => path.endsWith(extension))
            .map((path) => path.slice(dir.length + 1, -extension.length)),
        ] as const;
      }),
    ),
  ]);
  const description = describeSite({
    schema,
    config,
    edited: new Set(edited.filter((id): id is string => id !== null)),
    entries: Object.fromEntries(entries),
  });
  stdout(
    flags.boolean("json")
      ? `${JSON.stringify(description, null, 2)}\n`
      : formatDescription(description),
  );
  return 0;
}

async function doctorCommand(options: RunOptions & { flags: Flags }): Promise<number> {
  const { cwd, stdout, flags } = options;
  const root = resolve(cwd);
  const config = await loadConfig(root);
  const schema = await loadSchema(root);
  const files = nodeFiles(root);

  const u = ui();
  const lines: string[] = [
    u.step("GreatCMS setup"),
    u.kv([
      ["spec version", String(schema.version)],
      ["regions dir", config.content.regions],
    ]),
    "",
    u.step(`Regions (${Object.keys(schema.regions).length})`),
  ];

  const statuses = await Promise.all(
    Object.keys(schema.regions).map(async (regionId) => {
      const path = regionFilePath(config, regionId);
      return { regionId, path, exists: (await files.read(path)) !== null };
    }),
  );

  const idWidth = Math.max(0, ...statuses.map(({ regionId }) => regionId.length));
  let unedited = 0;
  for (const { regionId, path, exists } of statuses) {
    if (!exists) unedited += 1;
    lines.push(
      `  ${exists ? "edited " : u.muted("default")}  ${regionId.padEnd(idWidth)}  ${u.muted(`→ ${path}`)}`,
    );
  }

  if (unedited > 0) {
    lines.push(
      "",
      u.note(
        `${unedited} region${unedited === 1 ? "" : "s"} ${unedited === 1 ? "has" : "have"} no content file yet, and will render schema defaults. That is normal, not a problem.`,
      ),
    );
  }

  const collections = Object.keys(schema.collections);
  if (collections.length > 0) {
    lines.push("", u.step(`Collections (${collections.length})`), `  ${collections.join(", ")}`);
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
      u.warn(
        `${drafts.length} unsaved edit${drafts.length === 1 ? "" : "s"} in ${DRAFT_DIR}, which your dev server is showing instead of what is published:\n${drafts.map((path) => `  ${path}`).join("\n")}\nfix: publish it in the studio, or delete ${DRAFT_DIR} to go back to what is committed.`,
      ),
    );
  } else {
    lines.push("", u.ok("No drafts waiting: the dev server shows what is committed."));
  }

  stdout(`${lines.join("\n")}\n`);
  return 0;
}
