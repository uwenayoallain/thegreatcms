#!/usr/bin/env node
/**
 * Language-agnostic conformance verifier.
 *
 *   greatcms-conformance fixtures            # print the fixture site path
 *   greatcms-conformance verify ./out        # ./out holds <region-id>.json dumps
 *   greatcms-conformance verify --self       # check the reference reader
 *
 * A Hugo, Go, or PHP integration renders the fixture site, dumps each resolved
 * region as JSON, and runs `verify`. That is the whole contract — nothing about
 * the tool under test needs to be JavaScript.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { FIXTURES_DIR, readFixtureRegion, runConformance, verifyRegions } from "../dist/index.js";

const [, , command = "help", ...args] = process.argv;

if (command === "fixtures") {
  process.stdout.write(`${FIXTURES_DIR}\n`);
  process.exit(0);
}

if (command !== "verify") {
  process.stdout.write(
    [
      "greatcms-conformance — prove a tool reads the GreatCMS standard",
      "",
      "  fixtures              print the path to the fixture site",
      "  verify <dir>          compare <dir>/<region-id>.json against the expected documents",
      "  verify --self         verify the reference reader in @greatcms/conformance",
      "",
    ].join("\n"),
  );
  process.exit(command === "help" ? 0 : 1);
}

const result = args[0] === "--self" ? runConformance(readFixtureRegion) : verifyDirectory(args[0]);

if (result.ok) {
  process.stdout.write(`conformance: PASS (${result.checked} regions)\n`);
  process.exit(0);
}

process.stderr.write(
  `conformance: FAIL (${result.failures.length} of ${result.checked} regions)\n\n`,
);
for (const failure of result.failures) {
  process.stderr.write(`  ${failure.regionId}: ${failure.reason}\n`);
  if (failure.expected !== undefined) {
    process.stderr.write(`    expected: ${JSON.stringify(failure.expected)}\n`);
    process.stderr.write(`    actual:   ${JSON.stringify(failure.actual)}\n`);
  }
}
process.stderr.write("\n");
process.exit(1);

function verifyDirectory(dir) {
  if (!dir) {
    process.stderr.write("verify needs a directory, or --self\n");
    process.exit(2);
  }
  const abs = resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    process.stderr.write(`Not a directory: ${abs}\n`);
    process.exit(2);
  }
  const actual = {};
  for (const file of readdirSync(abs)) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    try {
      actual[id] = JSON.parse(readFileSync(join(abs, file), "utf8"));
    } catch (err) {
      process.stderr.write(`${file}: not valid JSON — ${err.message}\n`);
      process.exit(2);
    }
  }
  return verifyRegions(actual);
}
