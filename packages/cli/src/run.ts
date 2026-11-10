/** The binary's entry: flags, help and the version need nothing else; a command loads the rest. */

import { resolve } from "node:path";
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
} from "./commands.js";
import { CliError, UsageError } from "./ports.js";
import { defaultsOnlyPrompt, PromptCancelled, terminalPrompt, type PromptPort } from "./prompt.js";
import { plainUi, ui, useUi, type Ui } from "./ui.js";

export { createUi, wantsColour } from "./ui.js";
export { updateNotice } from "./update.js";
export { VERSION } from "./version.js";

type Handlers = typeof import("./handlers.js");
let handlers: Handlers | undefined;

/** YAML, the spec and every command's code: none of it is read for `--help` or `--version`. */
async function load(): Promise<Handlers> {
  handlers ??= await import("./handlers.js");
  return handlers;
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
export function isInteractive(): boolean {
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
        return await (
          await load()
        ).setupProject({
          root: resolve(options.cwd, flags.positionals[0] ?? "."),
          prompt,
          stdout,
        });
      }
      case "init":
        if (!rest.length && (options.prompt?.interactive || isInteractive())) {
          return await (
            await load()
          ).setupProject({
            root: options.cwd,
            prompt:
              options.prompt ?? terminalPrompt({ input: process.stdin, output: process.stdout }),
            stdout,
          });
        }
        return await (await load()).initCommand({ ...options, flags });
      case "add":
        return await (await load()).addCommand({ ...options, flags });
      case "check":
        return await (await load()).checkCommand({ ...options, flags });
      case "types":
        return await (await load()).typesCommand({ ...options, flags });
      case "doctor":
        return await (await load()).doctorCommand({ ...options, flags });
      case "describe":
        return await (await load()).describeCommand({ ...options, flags });
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
    // An AddError or SpecError can only come from code that `load()` has already brought in.
    const known =
      error instanceof CliError ||
      (handlers !== undefined &&
        (error instanceof handlers.AddError || error instanceof handlers.SpecError));
    if (known) {
      stderr(`${ui().err((error as Error).message)}\n`);
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
