#!/usr/bin/env node
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  process.stderr.write(`greatcms needs Node.js 20 or newer, and this is ${process.version}.\n`);
  process.exit(1);
}

// `greatcms describe | head` closes the pipe early; that is the reader being done, not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

// `check` runs a schema's `pattern` over content, often a pull request's: one that backtracks
// without end is handed to V8's linear-time engine instead of hanging CI.
(await import("node:v8")).setFlagsFromString(
  "--enable-experimental-regexp-engine-on-excessive-backtracks",
);

const { createUi, run, wantsColour } = await import("../dist/run.js");

process.exitCode = await run({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  ui: createUi(wantsColour(process.stdout)),
});
