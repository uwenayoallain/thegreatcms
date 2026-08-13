/**
 * Minimal interactive prompts — arrow keys, enter, Ctrl-C — with no
 * dependencies. A scaffolder that pulls in a prompt library, a colour library,
 * and a spinner is slower to install than it is to use.
 *
 * Everything degrades cleanly: with no TTY (CI, piped input, an agent running
 * the command) every prompt returns its default instead of hanging forever
 * waiting for a keypress nobody will press.
 */

import type { Interface as ReadlineInterface } from "node:readline";

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface PromptPort {
  select<T>(question: string, choices: Array<Choice<T>>, initial?: number): Promise<T>;
  text(question: string, initial: string): Promise<string>;
  confirm(question: string, initial: boolean): Promise<boolean>;
  note(text: string): void;
  /** False when prompting is impossible, so callers can explain themselves. */
  readonly interactive: boolean;
}

/** Answers every question with its default. Used for --yes, CI, and tests. */
export function defaultsOnlyPrompt(write: (text: string) => void = () => {}): PromptPort {
  return {
    interactive: false,
    note: (text) => write(`${text}\n`),
    async select<T>(question: string, choices: Array<Choice<T>>, initial = 0): Promise<T> {
      const choice = choices[initial] ?? choices[0];
      if (!choice) throw new Error(`No choices offered for "${question}".`);
      write(`${question} ${choice.label}\n`);
      return choice.value;
    },
    async text(question: string, initial: string): Promise<string> {
      write(`${question} ${initial}\n`);
      return initial;
    },
    async confirm(question: string, initial: boolean): Promise<boolean> {
      write(`${question} ${initial ? "yes" : "no"}\n`);
      return initial;
    },
  };
}

const DIM = "[2m";
const BOLD = "[1m";
const CYAN = "[36m";
const RESET = "[0m";

export interface TerminalPromptOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  /** Set false to drop colour, for terminals or logs that do not want it. */
  colour?: boolean;
}

export function terminalPrompt(options: TerminalPromptOptions): PromptPort {
  const { input, output } = options;
  const colour = options.colour ?? Boolean(output.isTTY);
  const paint = (code: string, text: string) => (colour ? `${code}${text}${RESET}` : text);

  return {
    interactive: true,
    note: (text) => output.write(`${text}\n`),

    select<T>(question: string, choices: Array<Choice<T>>, initial = 0): Promise<T> {
      return new Promise((resolve, reject) => {
        let index = Math.max(0, Math.min(initial, choices.length - 1));
        let rendered = 0;

        const draw = () => {
          if (rendered > 0) output.write(`[${rendered}A[0J`);
          const lines = choices.map((choice, i) => {
            const selected = i === index;
            const marker = selected ? paint(CYAN, "❯") : " ";
            const label = selected ? paint(BOLD, choice.label) : choice.label;
            const hint = choice.hint ? ` ${paint(DIM, `— ${choice.hint}`)}` : "";
            return `${marker} ${label}${hint}`;
          });
          output.write(`${lines.join("\n")}\n`);
          rendered = lines.length;
        };

        output.write(`${paint(BOLD, question)}\n`);
        draw();

        const onKey = (chunk: Buffer) => {
          const key = chunk.toString();

          if (key === "") {
            // Ctrl-C during a scaffold should leave nothing behind.
            cleanUp();
            output.write("\nCancelled. Nothing was written.\n");
            reject(new PromptCancelled());
            return;
          }
          if (key === "\r" || key === "\n") {
            cleanUp();
            const choice = choices[index];
            if (!choice) {
              reject(new Error(`No choices offered for "${question}".`));
              return;
            }
            output.write(`${paint(DIM, `  ${choice.label}`)}\n\n`);
            resolve(choice.value);
            return;
          }
          if (key === "[A" || key === "k") {
            index = (index - 1 + choices.length) % choices.length;
            draw();
          }
          if (key === "[B" || key === "j") {
            index = (index + 1) % choices.length;
            draw();
          }
        };

        const cleanUp = () => {
          input.off("data", onKey);
          if (input.isTTY) input.setRawMode(false);
          input.pause();
        };

        if (input.isTTY) input.setRawMode(true);
        input.resume();
        input.on("data", onKey);
      });
    },

    async text(question: string, initial: string): Promise<string> {
      const { createInterface } = await import("node:readline");
      const rl: ReadlineInterface = createInterface({ input, output });
      try {
        const answer = await new Promise<string>((resolve) => {
          rl.question(`${paint(BOLD, question)} ${paint(DIM, `(${initial})`)} `, (value) =>
            resolve(value),
          );
        });
        return answer.trim() || initial;
      } finally {
        rl.close();
      }
    },

    async confirm(question: string, initial: boolean): Promise<boolean> {
      const answer = await this.text(
        `${question} ${initial ? "[Y/n]" : "[y/N]"}`,
        initial ? "y" : "n",
      );
      return /^y/i.test(answer);
    },
  };
}

export class PromptCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "PromptCancelled";
  }
}
