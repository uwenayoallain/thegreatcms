/** Minimal interactive prompts, arrow keys, enter, Ctrl-C, with no dependencies. */

import type { Interface as ReadlineInterface } from "node:readline";
import { plainUi, ui } from "./ui.js";

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

export interface TerminalPromptOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  /** Set false to drop colour, for terminals or logs that do not want it. */
  colour?: boolean;
}

export function terminalPrompt(options: TerminalPromptOptions): PromptPort {
  const { input, output } = options;
  // The run's look when this is a terminal, so prompts match the rest of the output.
  const u = (options.colour ?? Boolean(output.isTTY)) ? ui() : plainUi;
  const ask = (question: string) => `${u.accent("?")} ${u.bold(question)}`;

  return {
    interactive: true,
    note: (text) => output.write(`${text}\n`),

    select<T>(question: string, choices: Array<Choice<T>>, initial = 0): Promise<T> {
      return new Promise((resolve, reject) => {
        let index = Math.max(0, Math.min(initial, choices.length - 1));
        let rendered = 0;

        const draw = () => {
          // Moving the cursor back only makes sense on a terminal; a log gets each redraw.
          if (rendered > 0 && output.isTTY) output.write(`\x1b[${rendered}A\x1b[0J`);
          const lines = choices.map((choice, i) => {
            const selected = i === index;
            const marker = selected ? u.accent("❯") : " ";
            const label = selected ? u.bold(choice.label) : choice.label;
            const hint = choice.hint ? `  ${u.muted(choice.hint)}` : "";
            return `  ${marker} ${label}${hint}`;
          });
          output.write(`${lines.join("\n")}\n`);
          rendered = lines.length;
        };

        output.write(`${ask(question)}\n`);
        draw();

        const onKey = (chunk: Buffer) => {
          const key = chunk.toString();

          if (key === "\x03" || key === "\x04") {
            // Ctrl-C or Ctrl-D during a scaffold should leave nothing behind.
            cancel();
            return;
          }
          if (key === "\r" || key === "\n") {
            cleanUp();
            const choice = choices[index];
            if (!choice) {
              reject(new Error(`No choices offered for "${question}".`));
              return;
            }
            output.write(`  ${u.accent("❯")} ${u.muted(choice.label)}\n\n`);
            resolve(choice.value);
            return;
          }
          if (key === "\x1b[A" || key === "k") {
            index = (index - 1 + choices.length) % choices.length;
            draw();
          }
          if (key === "\x1b[B" || key === "j") {
            index = (index + 1) % choices.length;
            draw();
          }
        };

        const cleanUp = () => {
          input.off("data", onKey);
          input.off("end", cancel);
          if (input.isTTY) input.setRawMode(false);
          input.pause();
        };
        // Input that closes mid-question is a cancel, not a promise left hanging forever.
        const cancel = () => {
          cleanUp();
          reject(new PromptCancelled());
        };

        if (input.isTTY) input.setRawMode(true);
        input.resume();
        input.on("data", onKey);
        input.once("end", cancel);
      });
    },

    async text(question: string, initial: string): Promise<string> {
      const { createInterface } = await import("node:readline");
      const rl: ReadlineInterface = createInterface({ input, output });
      try {
        const answer = await new Promise<string>((resolve, reject) => {
          rl.once("SIGINT", () => reject(new PromptCancelled()));
          rl.once("close", () => reject(new PromptCancelled()));
          rl.question(`${ask(question)} ${u.muted(`(${initial})`)} `, (value) => resolve(value));
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
