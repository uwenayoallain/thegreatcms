#!/usr/bin/env node
import { run } from "../dist/index.js";

process.exitCode = await run({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
