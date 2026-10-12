/** The terminal prompt, driven through streams instead of a person at a keyboard. */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PromptCancelled, terminalPrompt } from "./prompt.js";

function streams() {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const written: string[] = [];
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  (output as unknown as PassThrough).on("data", (chunk: Buffer) => written.push(chunk.toString()));
  return { input, output, written };
}

const choices = [
  { label: "Astro", value: "astro" },
  { label: "Next", value: "next" },
];

describe("choosing from a list", () => {
  it("takes the highlighted choice on Enter", async () => {
    const { input, output } = streams();
    const answer = terminalPrompt({ input, output }).select("Framework?", choices);
    (input as unknown as PassThrough).write("j");
    (input as unknown as PassThrough).write("\r");

    expect(await answer).toBe("next");
  });

  it("cancels when input closes, instead of waiting forever", async () => {
    const { input, output } = streams();
    const answer = terminalPrompt({ input, output }).select("Framework?", choices);
    (input as unknown as PassThrough).end();

    await expect(answer).rejects.toBeInstanceOf(PromptCancelled);
  });

  it("treats Ctrl-D like Ctrl-C", async () => {
    const { input, output } = streams();
    const answer = terminalPrompt({ input, output }).select("Framework?", choices);
    (input as unknown as PassThrough).write("\x04");

    await expect(answer).rejects.toBeInstanceOf(PromptCancelled);
  });

  it("writes no cursor movement into a log that is not a terminal", async () => {
    const { input, output, written } = streams();
    const answer = terminalPrompt({ input, output }).select("Framework?", choices);
    (input as unknown as PassThrough).write("j");
    (input as unknown as PassThrough).write("\r");
    await answer;

    expect(written.join("")).not.toContain("\x1b[");
  });
});
