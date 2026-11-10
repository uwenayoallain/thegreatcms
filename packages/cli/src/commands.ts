/** Every command and option the CLI takes: help, flag parsing and shell completion all read this one table. */

import { FRAMEWORKS } from "./detect.js";
import { TEMPLATES } from "./templates.js";
import { UsageError } from "./ports.js";
import { ui } from "./ui.js";
import { VERSION } from "./version.js";

export interface OptionSpec {
  name: string;
  short?: string;
  /** The value's placeholder in help; an option without one is a switch. */
  value?: string;
  choices?: readonly string[];
  /** Completes as a file or folder name. */
  path?: boolean;
  repeatable?: boolean;
  help: string;
}

export interface CommandSpec {
  name: string;
  /** The positional arguments, as help shows them. */
  args?: string;
  /** A shorter form for the overview, when `args` would not fit its column. */
  brief?: string;
  maxArgs: number;
  /** What the first positional argument can be, for validation and completion. */
  firstArg?: readonly string[] | "directory";
  summary: string;
  description: string;
  options: OptionSpec[];
  examples: string[];
}

const ISSUES_URL = "https://github.com/uwenayoallain/thegreatcms/issues";
const DOCS_URL =
  "https://github.com/uwenayoallain/thegreatcms/blob/main/apps/docs/content/docs/the-command-line.md";

const json: OptionSpec = { name: "json", help: "print the result as JSON, for CI and scripts" };
const yes: OptionSpec = { name: "yes", short: "y", help: "accept every default; never prompt" };

export const GLOBAL_OPTIONS: OptionSpec[] = [
  { name: "help", short: "h", help: "show help" },
  { name: "version", short: "v", help: "print the version" },
  { name: "no-color", help: "plain text, no colour (NO_COLOR=1 does the same)" },
];

const ADD_KINDS = ["region", "section", "block", "collection"] as const;

export const COMMANDS: CommandSpec[] = [
  {
    name: "setup",
    args: "[directory]",
    maxArgs: 1,
    firstArg: "directory",
    summary: "scan a project and set up the CMS step by step",
    description:
      "Scans a new or existing project or workspace, finds the apps inside it, and helps you build regions, reusable sections and collections. Every file it would write is shown before anything changes, and cancelling writes nothing.",
    options: [],
    examples: ["greatcms setup", "greatcms setup ./apps/web"],
  },
  {
    name: "init",
    maxArgs: 0,
    summary: "set up .cms/schema.yaml and .cms/config.yaml",
    description:
      "Detects the framework, writes a commented schema and config, adds @greatcms/reader to package.json and connects the studio's live preview. Run in a terminal with no options, it starts the guided `greatcms setup` instead.",
    options: [
      yes,
      { name: "name", value: "<name>", help: "site name" },
      {
        name: "framework",
        value: "<id>",
        choices: Object.keys(FRAMEWORKS),
        help: "what the site is built with",
      },
      {
        name: "template",
        value: "<id>",
        choices: TEMPLATES.map((template) => template.id),
        help: "what the CMS manages to begin with",
      },
      { name: "dir", value: "<path>", path: true, help: "where content files live" },
      { name: "force", short: "f", help: "overwrite an existing setup" },
      { name: "no-wire", help: "leave package.json and the framework config alone" },
    ],
    examples: ["greatcms init --yes", "greatcms init --yes --framework astro --template blog"],
  },
  {
    name: "add",
    args: "<region|section|block|collection> <name>",
    brief: "<kind> <name>",
    maxArgs: 2,
    firstArg: ADD_KINDS,
    summary: "add a region, section, block or collection to the schema",
    description:
      "Edits .cms/schema.yaml as text, so its comments survive. A region is a managed part of a page; a section is a reusable page section, made selectable in a reorderable region; a block is a block type a blocks region can hold; a collection is a folder of entries. Without --field, it asks for the fields in a terminal.",
    options: [
      {
        name: "field",
        value: "<name:type>",
        repeatable: true,
        help: "repeatable. Types: text richtext image link number boolean date file, select(a|b), list(text), blocks(a|b). A trailing ! means required",
      },
      { name: "label", value: "<text>", help: "what an editor sees (default: from the name)" },
      { name: "to", value: "<region>", help: "the region a section goes in" },
      {
        name: "blocks",
        value: "<a,b>",
        help: "make the region a reorderable list of these blocks",
      },
      {
        name: "format",
        value: "<format>",
        choices: ["markdown", "mdx", "json"],
        help: "collections only, markdown by default",
      },
      { name: "dir", value: "<path>", path: true, help: "collections only: where entries live" },
      yes,
    ],
    examples: [
      "greatcms add region about.intro --field heading:text! --field body:richtext",
      "greatcms add section testimonial --field quote:richtext! --field name:text!",
      "greatcms add region home.sections --blocks card,testimonial",
      "greatcms add collection posts --field title:text! --field date:date",
    ],
  },
  {
    name: "check",
    maxArgs: 0,
    summary: "validate content against the schema, media and internal links",
    description:
      "Exits 1 when anything would not render, or would render broken, so CI can run it. Warnings are listed apart and do not fail the run.",
    options: [json],
    examples: ["greatcms check", "greatcms check --json"],
  },
  {
    name: "types",
    maxArgs: 0,
    summary: "generate TypeScript for every region, block and collection",
    description:
      'Includes the augmentation that types cms.region("home.hero") by its id. Prints to stdout without --out.',
    options: [
      { name: "out", short: "o", value: "<path>", path: true, help: "write to this file" },
      { name: "check", help: "exit 1 if the --out file is out of date, so CI catches drift" },
      { name: "module", value: "<specifier>", help: "the module the augmentation targets" },
    ],
    examples: ["greatcms types --out src/cms.d.ts", "greatcms types --out src/cms.d.ts --check"],
  },
  {
    name: "doctor",
    maxArgs: 0,
    summary: "show how this repository is set up, and any unsaved draft",
    description:
      "Lists every region, the file it resolves to, which ones still render schema defaults, and any unsaved edit left in .cms/draft/.",
    options: [json],
    examples: ["greatcms doctor"],
  },
  {
    name: "fonts",
    maxArgs: 0,
    summary: "serve an Astro site's Google Fonts from the site itself",
    description:
      "Reads the Google Fonts link the site has and makes the change: the families go into astro.config, a tag for each into the layout's head, and the CSS points at them, with fallbacks sized to match so text does not move. It changes nothing when a file is not shaped the way it expects.",
    options: [{ name: "dry-run", help: "say what would change, and write nothing" }],
    examples: ["greatcms fonts --dry-run", "greatcms fonts"],
  },
  {
    name: "describe",
    maxArgs: 0,
    summary: "print the content model: every region, block, collection and field",
    description:
      "One screen for whoever is about to write content by hand, a person or a coding agent: each field with its type, limits, condition and default, and where its file goes.",
    options: [json],
    examples: ["greatcms describe", "greatcms describe --json"],
  },
  {
    name: "studio",
    maxArgs: 0,
    summary: "open the visual editor for this site, on this machine",
    description:
      "Starts the GreatCMS studio on 127.0.0.1 with this folder as its one site, opens it in your browser with no sign-in, and shows the site's dev server as the live preview: the one already running, or the site's own dev command started here and stopped with it. It trusts whoever can reach it on this machine, other users of a shared one included, which is why it only listens on loopback. Publishing commits to this working copy as you; nothing is pushed. Needs Node.js 22.13 or newer and the @greatcms/studio package, which it offers to install.",
    options: [
      {
        name: "port",
        value: "<number>",
        help: "the studio's port (default: 4983, or the next free one)",
      },
      {
        name: "host",
        value: "<address>",
        help: "listen somewhere other than 127.0.0.1; anything but loopback needs STUDIO_PASSWORD",
      },
      {
        name: "dev-url",
        value: "<url>",
        help: "the site's dev server, when it is already running",
      },
      { name: "no-dev", help: "do not look for or start a dev server: edit without the preview" },
      { name: "no-open", help: "print the studio's address without opening a browser" },
    ],
    examples: [
      "greatcms studio",
      "greatcms studio --port 5000 --no-open",
      "greatcms studio --dev-url http://localhost:4321",
    ],
  },
  {
    name: "completion",
    args: "<bash|zsh|fish>",
    maxArgs: 1,
    firstArg: ["bash", "zsh", "fish"],
    summary: "print a shell completion script",
    description:
      "Prints a script that completes commands, options and their values. To install it:",
    options: [],
    examples: [
      "greatcms completion bash > ~/.local/share/bash-completion/completions/greatcms",
      'greatcms completion zsh > "${fpath[1]}/_greatcms"',
      "greatcms completion fish > ~/.config/fish/completions/greatcms.fish",
    ],
  },
  {
    name: "help",
    args: "[command]",
    maxArgs: 1,
    summary: "show help for a command",
    description: "Shows a command's options and examples.",
    options: [],
    examples: ["greatcms help add"],
  },
];

// `help` completes and validates against the commands, which only exist once the table does.
COMMANDS.find((command) => command.name === "help")!.firstArg = COMMANDS.map((c) => c.name);

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

const ALL_OPTIONS = new Map<string, OptionSpec>(
  [...GLOBAL_OPTIONS, ...COMMANDS.flatMap((command) => command.options)].map((option) => [
    option.name,
    option,
  ]),
);
const BY_SHORT = new Map<string, OptionSpec>(
  [...ALL_OPTIONS.values()].flatMap((option) => (option.short ? [[option.short, option]] : [])),
);

export interface Flags {
  /** The last value given for an option. */
  string(name: string): string | undefined;
  /** Every value given for a repeatable option, in order. */
  strings(name: string): string[];
  boolean(name: string): boolean;
  /** Arguments that are not flags or flag values, in order. */
  positionals: string[];
  /** Flags no command understands, as typed, so a typo is reported rather than ignored. */
  unknown: string[];
  /** Known options, each as the user typed it, for checking against the command. */
  given: Array<{ option: OptionSpec; typed: string }>;
  /** Options that take a value but were given none. */
  missingValue: string[];
}

/**
 * Long options as `--name value` or `--name=value`, short ones as `-y`, `-yf`
 * or `-o path`, and `--` ends the options. A switch never takes a value, so
 * `--yes hero.banner` leaves the name where it was typed.
 */
export function parseFlags(argv: string[]): Flags {
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  const unknown: string[] = [];
  const given: Flags["given"] = [];
  const missingValue: string[] = [];

  const takesNext = (index: number) => {
    const next = argv[index];
    return next !== undefined && (next === "-" || !next.startsWith("-"));
  };
  const record = (option: OptionSpec, typed: string, value?: string) => {
    given.push({ option, typed });
    const list = values.get(option.name) ?? [];
    if (value !== undefined) list.push(value);
    else if (option.value) missingValue.push(typed);
    values.set(option.name, list);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const [name = "", inline] = token.slice(2).split(/=(.*)/s, 2);
      const option = ALL_OPTIONS.get(name);
      if (!option) {
        unknown.push(token);
      } else if (!option.value) {
        record(option, `--${name}`);
      } else if (inline !== undefined) {
        record(option, `--${name}`, inline);
      } else if (takesNext(i + 1)) {
        record(option, `--${name}`, argv[(i += 1)]);
      } else {
        record(option, `--${name}`);
      }
      continue;
    }
    if (token.length > 1 && token.startsWith("-")) {
      for (let at = 1; at < token.length; at += 1) {
        const letter = token[at] as string;
        const option = BY_SHORT.get(letter);
        if (!option) {
          unknown.push(`-${letter}`);
          continue;
        }
        if (!option.value) {
          record(option, `-${letter}`);
          continue;
        }
        const rest = token.slice(at + 1);
        if (rest) record(option, `-${letter}`, rest);
        else if (takesNext(i + 1)) record(option, `-${letter}`, argv[(i += 1)]);
        else record(option, `-${letter}`);
        break;
      }
      continue;
    }
    positionals.push(token);
  }

  return {
    string: (name) => values.get(name)?.at(-1),
    strings: (name) => values.get(name) ?? [],
    boolean: (name) => values.has(name),
    positionals,
    unknown,
    given,
    missingValue,
  };
}

/** Refuses what the command cannot use, naming the nearest thing it can. */
export function validate(command: CommandSpec, flags: Flags): void {
  const allowed = [...command.options, ...GLOBAL_OPTIONS];
  const spellings = allowed.flatMap((option) => [`--${option.name}`]);
  const offTable = [
    ...flags.unknown,
    ...flags.given
      .filter(({ option }) => !allowed.some((entry) => entry.name === option.name))
      .map(({ typed }) => typed),
  ];
  if (offTable.length > 0) {
    const [first] = offTable as [string];
    const near = first.startsWith("--") ? closest(first, spellings) : undefined;
    throw new UsageError(
      `Unknown option ${offTable.join(", ")} for greatcms ${command.name}.`,
      near
        ? `Did you mean ${near}? Run \`greatcms help ${command.name}\` to see its options.`
        : `Run \`greatcms help ${command.name}\` to see the options it takes.`,
    );
  }
  const [typed] = flags.missingValue;
  if (typed) {
    const option = flags.given.find((entry) => entry.typed === typed)!.option;
    throw new UsageError(
      `${typed} needs a value.`,
      `Give it one: --${option.name} ${option.value}${option.choices ? `, one of ${option.choices.join(", ")}` : ""}.`,
    );
  }
  for (const option of allowed) {
    if (!option.choices) continue;
    for (const value of flags.strings(option.name)) {
      if (option.choices.includes(value)) continue;
      throw new UsageError(
        `--${option.name} cannot be "${value}".`,
        withSuggestion(value, option.choices, `Choose one of: ${option.choices.join(", ")}.`),
      );
    }
  }
  if (flags.positionals.length > command.maxArgs) {
    const extra = flags.positionals.slice(command.maxArgs);
    throw new UsageError(
      command.maxArgs === 0
        ? `greatcms ${command.name} takes no arguments, but was given ${quoteList(extra)}.`
        : `greatcms ${command.name} takes at most ${command.maxArgs}, but was also given ${quoteList(extra)}.`,
      `Run it as \`${usage(command)}\`.`,
    );
  }
  const [first] = flags.positionals;
  if (first !== undefined && Array.isArray(command.firstArg) && !command.firstArg.includes(first)) {
    throw new UsageError(
      `greatcms ${command.name} cannot take "${first}".`,
      withSuggestion(first, command.firstArg, `It takes one of: ${command.firstArg.join(", ")}.`),
    );
  }
}

export function unknownCommand(name: string): UsageError {
  return new UsageError(
    `Unknown command "${name}".`,
    withSuggestion(
      name,
      COMMANDS.map((command) => command.name),
      "Run `greatcms --help` to see the commands.",
      (near) => `Did you mean \`greatcms ${near}\`? Run \`greatcms --help\` to see the commands.`,
    ),
  );
}

function withSuggestion(
  input: string,
  candidates: readonly string[],
  otherwise: string,
  phrase: (near: string) => string = (near) => `Did you mean "${near}"? ${otherwise}`,
): string {
  const near = closest(input, candidates);
  return near ? phrase(near) : otherwise;
}

/** The candidate a typo most likely meant: a few edits away, or the only one it starts. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  const lower = input.toLowerCase();
  const limit = Math.max(1, Math.min(3, Math.floor(lower.length / 3)));
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance <= limit && (!best || distance < best.distance)) best = { candidate, distance };
  }
  if (best) return best.candidate;
  const prefixed = candidates.filter((candidate) => candidate.startsWith(lower));
  return lower.length >= 2 && prefixed.length === 1 ? prefixed[0] : undefined;
}

/** Optimal string alignment: a swapped pair of letters counts as one edit, as it is one slip. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_row, i) =>
    Array.from({ length: b.length + 1 }, (_column, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = value;
    }
  }
  return rows[a.length]![b.length]!;
}

function quoteList(values: string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function usage(command: CommandSpec): string {
  return `greatcms ${command.name}${command.args ? ` ${command.args}` : ""}${command.options.length ? " [options]" : ""}`;
}

export function versionText(): string {
  return `greatcms ${VERSION}\n`;
}

const WIDTH = 80;

/** Breaks `text` to the width, every line after the first indented to `hang`. */
function wrap(text: string, start: number, hang: number): string {
  const lines: string[] = [];
  let line = "";
  let room = WIDTH - start;
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > room) {
      lines.push(line);
      line = word;
      room = WIDTH - hang;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines.join(`\n${" ".repeat(hang)}`);
}

function table(rows: Array<[string, string]>, paint: (text: string) => string): string {
  const width = Math.min(30, Math.max(...rows.map(([left]) => left.length)) + 2);
  return rows
    .map(([left, right]) => {
      const pad =
        left.length + 2 > width ? `\n${" ".repeat(width + 2)}` : " ".repeat(width - left.length);
      return `  ${paint(left)}${pad}${wrap(right, width + 2, width + 2)}`;
    })
    .join("\n");
}

function optionRows(options: OptionSpec[]): Array<[string, string]> {
  return options.map((option) => [
    `${option.short ? `-${option.short}, ` : "    "}--${option.name}${option.value ? ` ${option.value}` : ""}`,
    option.choices ? `${option.help}. One of: ${option.choices.join(", ")}` : option.help,
  ]);
}

/** `greatcms --help`: what each command is for, and where to look next. */
export function overviewHelp(): string {
  const u = ui();
  const heading = (text: string) => u.bold(text);
  return [
    `${u.bold(`greatcms ${VERSION}`)}: local tools for a Git-backed site`,
    "",
    `${heading("Usage:")} greatcms <command> [options]`,
    "",
    heading("Commands:"),
    table(
      COMMANDS.map((command) => [
        `${command.name}${command.args ? ` ${command.brief ?? command.args}` : ""}`,
        command.summary,
      ]),
      u.accent,
    ),
    "",
    heading("Options:"),
    table(optionRows(GLOBAL_OPTIONS), u.accent),
    "",
    wrap(
      "Run `greatcms help <command>` for a command's options and examples. Exit status: 0 done, 1 failed or found problems, 2 bad usage, 130 cancelled.",
      0,
      0,
    ),
    "",
    wrap(
      "Everything here runs on your machine, with your toolchain. Nothing from this repository is ever executed by the studio.",
      0,
      0,
    ),
    "",
    `Docs:   ${DOCS_URL}`,
    `Issues: ${ISSUES_URL}`,
    "",
  ].join("\n");
}

/** `greatcms help <command>`: its usage, what it does, its options, and examples to copy. */
export function commandHelp(command: CommandSpec): string {
  const u = ui();
  return [
    `${u.bold("Usage:")} ${u.accent(usage(command))}`,
    "",
    wrap(command.description, 0, 0),
    "",
    u.bold("Options:"),
    table(optionRows([...command.options, ...GLOBAL_OPTIONS.slice(0, 1)]), u.accent),
    "",
    u.bold("Examples:"),
    ...command.examples.map((example) => `  ${example}`),
    "",
  ].join("\n");
}

/** Shown when something fails that greatcms did not expect: the message, and where to report it. */
export function crashText(error: unknown, debug: boolean): string {
  const u = ui();
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && debug ? `\n\n${error.stack ?? ""}` : "";
  const advice = [`This is a bug. Please report it with the command you ran: ${ISSUES_URL}`];
  if (!debug) advice.push("Run it again with GREATCMS_DEBUG=1 for the stack trace.");
  return `${u.err(`greatcms ${VERSION} hit an error it did not expect: ${message}`)}\n${u.note(advice.join("\n"))}${stack}\n`;
}

// Shell completion. Each script is generated from the table above, so a new
// option completes the day it is added.

const valueOptions = () => [...ALL_OPTIONS.values()].filter((option) => option.value);
const spellingsOf = (option: OptionSpec) => [
  `--${option.name}`,
  ...(option.short ? [`-${option.short}`] : []),
];

function bashScript(): string {
  const cases = valueOptions().map((option) => {
    const patterns = spellingsOf(option).join("|");
    if (option.choices) {
      return `    ${patterns}) COMPREPLY=($(compgen -W "${option.choices.join(" ")}" -- "$cur")); return ;;`;
    }
    if (option.path) return `    ${patterns}) COMPREPLY=($(compgen -f -- "$cur")); return ;;`;
    return `    ${patterns}) compopt +o default 2>/dev/null; COMPREPLY=(); return ;;`;
  });
  const commands = COMMANDS.map((command) => {
    const options = [...command.options, ...GLOBAL_OPTIONS].flatMap(spellingsOf).join(" ");
    const first =
      command.firstArg === "directory"
        ? `compgen -d -- "$cur"`
        : command.firstArg
          ? `compgen -W "${command.firstArg.join(" ")}" -- "$cur"`
          : null;
    return [
      `    ${command.name})`,
      `      opts="${options}"`,
      ...(first
        ? [
            `      if [[ $cur != -* ]] && (( COMP_CWORD == 2 )); then COMPREPLY=($(${first})); return; fi`,
          ]
        : []),
      "      ;;",
    ].join("\n");
  });
  const top = [
    ...COMMANDS.map((command) => command.name),
    ...GLOBAL_OPTIONS.flatMap(spellingsOf),
  ].join(" ");
  return `# bash completion for greatcms ${VERSION}. Install it with:
#   greatcms completion bash > ~/.local/share/bash-completion/completions/greatcms
_greatcms() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" opts=""
  if (( COMP_CWORD == 1 )); then
    COMPREPLY=($(compgen -W "${top}" -- "$cur"))
    return
  fi
  case "$prev" in
${cases.join("\n")}
  esac
  case "\${COMP_WORDS[1]}" in
${commands.join("\n")}
  esac
  if [[ $cur == -* ]]; then COMPREPLY=($(compgen -W "$opts" -- "$cur")); fi
}
complete -o default -F _greatcms greatcms
`;
}

const zshQuote = (text: string) => text.replaceAll("'", "'\\''");
const zshDescription = (text: string) =>
  zshQuote(text.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]"));

function zshOption(option: OptionSpec): string {
  const names = spellingsOf(option);
  let action = "";
  if (option.value) {
    const message = option.value.replace(/[<>]/g, "").replaceAll(":", "\\:");
    const values = option.choices ? `(${option.choices.join(" ")})` : option.path ? "_files" : " ";
    action = `:${zshQuote(message)}:${values}`;
  }
  const tail = `[${zshDescription(option.help)}]${action}`;
  if (names.length > 1) return `'(${names.join(" ")})'{${names.join(",")}}'${tail}'`;
  return `'${option.repeatable ? "*" : ""}${names[0]}${tail}'`;
}

function zshScript(): string {
  const described = COMMANDS.map(
    (command) => `    '${command.name}:${zshQuote(command.summary)}'`,
  ).join("\n");
  const cases = COMMANDS.map((command) => {
    const specs = [...command.options, GLOBAL_OPTIONS[0]!].map(zshOption);
    if (command.firstArg === "directory") specs.push("'1:directory:_files -/'");
    else if (command.firstArg) specs.push(`'1:${command.name}:(${command.firstArg.join(" ")})'`);
    if (command.maxArgs > 1) specs.push("'*:name: '");
    return `    ${command.name})\n      _arguments -s \\\n        ${specs.join(" \\\n        ")}\n      ;;`;
  }).join("\n");
  return `#compdef greatcms
# zsh completion for greatcms ${VERSION}. Install it with:
#   greatcms completion zsh > "\${fpath[1]}/_greatcms"
_greatcms() {
  local -a commands
  commands=(
${described}
  )
  if (( CURRENT == 2 )); then
    _describe -t commands 'greatcms command' commands
    _arguments ${GLOBAL_OPTIONS.map(zshOption).join(" ")}
    return
  fi
  local command=$words[2]
  shift words
  (( CURRENT-- ))
  case $command in
${cases}
  esac
}
if [ "$funcstack[1]" = "_greatcms" ]; then
  _greatcms "$@"
else
  compdef _greatcms greatcms
fi
`;
}

const fishQuote = (text: string) => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

function fishOption(option: OptionSpec, condition: string): string {
  const parts = ["complete -c greatcms"];
  if (condition) parts.push(`-n ${fishQuote(condition)}`);
  if (option.short) parts.push(`-s ${option.short}`);
  parts.push(`-l ${option.name}`);
  if (option.choices) parts.push(`-x -a ${fishQuote(option.choices.join(" "))}`);
  else if (option.path) parts.push("-r -F");
  else if (option.value) parts.push("-x");
  parts.push(`-d ${fishQuote(option.help)}`);
  return parts.join(" ");
}

function fishScript(): string {
  const lines = [
    `# fish completion for greatcms ${VERSION}. Install it with:`,
    "#   greatcms completion fish > ~/.config/fish/completions/greatcms.fish",
    "complete -c greatcms -f",
    ...COMMANDS.map(
      (command) =>
        `complete -c greatcms -n __fish_use_subcommand -a ${command.name} -d ${fishQuote(command.summary)}`,
    ),
    ...GLOBAL_OPTIONS.map((option) => fishOption(option, "")),
  ];
  for (const command of COMMANDS) {
    const seen = `__fish_seen_subcommand_from ${command.name}`;
    lines.push(...command.options.map((option) => fishOption(option, seen)));
    if (command.firstArg === "directory") {
      lines.push(`complete -c greatcms -n ${fishQuote(seen)} -a '(__fish_complete_directories)'`);
    } else if (command.firstArg) {
      lines.push(
        `complete -c greatcms -n ${fishQuote(`${seen}; and not __fish_seen_subcommand_from ${command.firstArg.join(" ")}`)} -a ${fishQuote(command.firstArg.join(" "))}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function completionScript(shell: string): string {
  if (shell === "bash") return bashScript();
  if (shell === "zsh") return zshScript();
  return fishScript();
}
