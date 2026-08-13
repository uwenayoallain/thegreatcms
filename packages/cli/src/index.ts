/**
 * @greatcms/cli — the local half of the workflow.
 *
 *   greatcms preview --run "pnpm dev"   overlay drafts, run your dev server
 *   greatcms doctor                      check this repository's CMS setup
 *
 * The studio owns publishing; this owns everything that should happen on your
 * machine, with your toolchain, running your code.
 */

import { spawn } from "node:child_process";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_CONFIG,
  parseConfig,
  parseSchema,
  regionFilePath,
  SpecError,
  type CmsConfig,
  type CmsSchema,
} from "@greatcms/spec";
import {
  applyOverlay,
  assertContentIsClean,
  describePlan,
  planPreview,
  PreviewError,
  type FilePort,
  type GitPort,
} from "./preview.js";

const execFileAsync = promisify(execFile);

export function nodeGit(cwd: string): GitPort {
  return {
    async run(args: string[]): Promise<string> {
      try {
        const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
        return stdout;
      } catch (error) {
        const details = (error as { stderr?: string }).stderr?.trim();
        throw new PreviewError(
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
    throw new PreviewError(
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
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function run(options: RunOptions): Promise<number> {
  const { argv, stdout, stderr } = options;
  const [command = "help", ...rest] = argv;
  const flags = parseFlags(rest);

  try {
    switch (command) {
      case "preview":
        return await previewCommand({ ...options, flags });
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
    if (error instanceof PreviewError || error instanceof SpecError) {
      stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function previewCommand(options: RunOptions & { flags: Flags }): Promise<number> {
  const { cwd, stdout, flags } = options;
  const root = resolve(cwd);
  const git = nodeGit(root);
  const files = nodeFiles(root);
  const config = await loadConfig(root);

  await assertContentIsClean(git, config, flags.boolean("force"));

  const plan = await planPreview(git, files, {
    config,
    branch: flags.string("branch"),
    remote: flags.string("remote") ?? "origin",
    force: flags.boolean("force"),
  });

  stdout(`${describePlan(plan)}\n`);

  if (flags.boolean("diff")) return 0;

  const restore = await applyOverlay(files, plan);
  stdout("\nDraft content is in place.\n");

  const command = flags.string("run");
  if (!command) {
    stdout(
      `Start your dev server. When you are done, put your working copy back with:\n  git checkout -- ${config.content.regions} ${config.content.media}\n`,
    );
    return 0;
  }

  // The dev server runs here, on your machine, with your toolchain — the studio
  // never executes anything from this repository.
  stdout(`Running: ${command}\n\n`);
  const code = await runUntilExit(command, root, restore);
  stdout("\nWorking copy restored.\n");
  return code;
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
  lines.push(
    `  preview        ${config.preview?.urlTemplate ?? "not configured (set preview.urlTemplate for inline previews)"}`,
  );
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

  stdout(`${lines.join("\n")}\n`);
  return 0;
}

function runUntilExit(command: string, cwd: string, restore: () => Promise<void>): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit" });

    let restored = false;
    const cleanUp = async (code: number) => {
      if (restored) return;
      restored = true;
      await restore();
      resolvePromise(code);
    };

    // Ctrl-C must still restore the working copy, so the signal is handled here
    // rather than left to kill the process outright.
    const onSignal = () => {
      child.kill("SIGINT");
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    child.on("exit", (code) => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      void cleanUp(code ?? 0);
    });
  });
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

  greatcms preview [options]     overlay draft content and run your dev server
    --run "<command>"            dev server to run; restored when it exits
    --branch <name>              one draft branch (default: all of them)
    --remote <name>              default: origin
    --diff                       show what would change, write nothing
    --force                      overlay even with uncommitted content changes

  greatcms doctor                check this repository's CMS setup

The preview build runs here, with your toolchain. Nothing from this repository
is ever executed by the studio.
`;
