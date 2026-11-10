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

const { createUi, run, updateNotice, VERSION, wantsColour } = await import("../dist/run.js");

const argv = process.argv.slice(2);
// Asked alongside the command, so a command never waits for npm before it starts.
const notice = updateNotice({
  current: VERSION,
  cwd: process.cwd(),
  interactive: Boolean(process.stderr.isTTY),
}).catch(() => null);
// The studio runs until it is stopped, so it is told at the start.
if (argv[0] === "studio") process.stderr.write((await notice) ?? "");

process.exitCode = await run({
  argv,
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  ui: createUi(wantsColour(process.stdout)),
});
if (argv[0] !== "studio") process.stderr.write((await notice) ?? "");
