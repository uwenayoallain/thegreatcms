/** What anyone expects of a command line: a version, help per command, suggestions for typos, exit codes, completion. */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closest, COMMANDS, GLOBAL_OPTIONS } from "./commands.js";
import { createUi, run, VERSION } from "./index.js";
import type { PromptPort } from "./prompt.js";

async function cli(argv: string[], extra: Partial<Parameters<typeof run>[0]> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run({
    argv,
    cwd: tmpdir(),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...extra,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("the version", () => {
  it.each([["--version"], ["-v"], ["version"], ["check", "--version"]])(
    "prints it for %s",
    async (...argv) => {
      expect(await cli(argv)).toEqual({ code: 0, out: `greatcms ${VERSION}\n`, err: "" });
    },
  );
});

describe("help", () => {
  it("lists every command, the global options and the exit codes", async () => {
    const { code, out } = await cli(["--help"]);
    expect(code).toBe(0);
    for (const command of COMMANDS) expect(out).toContain(`  ${command.name}`);
    for (const option of GLOBAL_OPTIONS) expect(out).toContain(`--${option.name}`);
    expect(out).toContain("2 bad usage");
  });

  it("is the same for `help <command>` and `<command> --help`, and only about that command", async () => {
    const a = await cli(["help", "types"]);
    const b = await cli(["types", "-h"]);
    expect(a).toEqual(b);
    expect(a.out).toContain("Usage: greatcms types [options]");
    expect(a.out).toContain("-o, --out <path>");
    expect(a.out).not.toContain("--framework");
  });

  it("shows help even when the rest of the line is wrong", async () => {
    expect((await cli(["init", "--bogus", "--help"])).code).toBe(0);
  });

  it("documents every option a command takes, with its choices", async () => {
    for (const command of COMMANDS) {
      // oxlint-disable-next-line no-await-in-loop -- each run swaps the shared ui
      const { out } = await cli(["help", command.name]);
      for (const option of command.options) {
        expect(out).toContain(`--${option.name}`);
        for (const choice of option.choices ?? []) expect(out).toContain(choice);
      }
    }
  });

  it("drops colour for --no-color, wherever it is typed", async () => {
    const coloured = await cli(["help"], { ui: createUi(true, {}) });
    expect(coloured.out).toContain("\x1b[");
    expect((await cli(["help", "--no-color"], { ui: createUi(true, {}) })).out).not.toContain(
      "\x1b[",
    );
  });
});

describe("mistakes", () => {
  it("suggests the command a typo meant, and exits 2", async () => {
    const { code, err } = await cli(["chekc"]);
    expect(code).toBe(2);
    expect(err).toContain("Did you mean `greatcms check`?");
  });

  it("refuses an option that belongs to another command", async () => {
    const { code, err } = await cli(["check", "--force"]);
    expect(code).toBe(2);
    expect(err).toContain("Unknown option --force for greatcms check");
  });

  it("refuses a value outside an option's choices, suggesting the nearest", async () => {
    const { code, err } = await cli(["init", "--yes", "--framework", "astr"]);
    expect(code).toBe(2);
    expect(err).toContain('Did you mean "astro"?');
  });

  it("asks for a value an option needs", async () => {
    const { code, err } = await cli(["types", "--out"]);
    expect(code).toBe(2);
    expect(err).toContain("--out needs a value");
  });

  it("refuses arguments a command does not take", async () => {
    expect((await cli(["check", "everything"])).code).toBe(2);
    expect((await cli(["add", "regoin", "x"])).err).toContain('Did you mean "region"?');
  });

  it("finds near misses without inventing them", () => {
    expect(closest("descirbe", ["describe", "doctor"])).toBe("describe");
    expect(closest("comp", ["completion", "check"])).toBe("completion");
    expect(closest("zzz", ["check", "types"])).toBeUndefined();
  });

  it("reports a failure it did not expect as a bug, with where to report it, and no stack", async () => {
    const root = mkdtempSync(join(tmpdir(), "greatcms-crash-"));
    writeFileSync(join(root, "package.json"), "{}");
    await cli(["init", "--yes", "--template", "blank"], { cwd: root });
    const broken: PromptPort = {
      interactive: true,
      note: () => {},
      text: () => Promise.reject(new Error("the terminal went away")),
      select: () => Promise.reject(new Error("unused")),
      confirm: () => Promise.reject(new Error("unused")),
    } as unknown as PromptPort;

    const { code, err } = await cli(["add", "region", "about"], { cwd: root, prompt: broken });
    expect(code).toBe(1);
    expect(err).toContain("the terminal went away");
    expect(err).toContain("github.com/uwenayoallain/thegreatcms/issues");
    expect(err).not.toContain("    at ");
  });
});

/** What bash offers for `words`, with the script loaded. */
const bash = (script: string, words: string) =>
  execFileSync(
    "bash",
    [
      "-c",
      `${script}\nCOMP_WORDS=(${words}); COMP_CWORD=$((\${#COMP_WORDS[@]}-1)); _greatcms; echo "\${COMPREPLY[*]}"`,
    ],
    { encoding: "utf8" },
  ).trim();

describe("shell completion", () => {
  it("completes commands, options and their values in bash", async () => {
    const { out: script } = await cli(["completion", "bash"]);
    expect(bash(script, "greatcms ch")).toBe("check");
    expect(bash(script, 'greatcms init --framework ""')).toBe(
      "astro next nuxt sveltekit eleventy generic",
    );
    expect(bash(script, 'greatcms add ""')).toBe("region section block collection");
    expect(bash(script, "greatcms add region x --bl")).toBe("--blocks");
    expect(bash(script, "greatcms types -")).toContain("--out");
  });

  it.each(["zsh", "fish"])(
    "writes a %s script that parses, when the shell is here",
    async (shell) => {
      const { out: script } = await cli(["completion", shell]);
      expect(script).toContain("greatcms");
      const present = spawnSync(shell, ["-c", "true"]).status === 0;
      if (!present) return;
      const file = join(mkdtempSync(join(tmpdir(), "greatcms-completion-")), `greatcms.${shell}`);
      writeFileSync(file, script);
      expect(spawnSync(shell, ["-n", file]).status).toBe(0);
    },
  );

  it("asks which shell, and refuses one it does not know", async () => {
    expect((await cli(["completion"])).code).toBe(2);
    expect((await cli(["completion", "powershell"])).code).toBe(2);
  });
});
