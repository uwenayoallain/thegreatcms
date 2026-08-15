#!/usr/bin/env node
/** Language-agnostic conformance verifier. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FIXTURES_DIR,
  readFixtureEntries,
  readFixtureRegion,
  runConformance,
  verifyEntries,
  verifyRegions,
} from "../dist/index.js";

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
      "  verify <dir>          compare a reader's output against the expected documents",
      "  verify --self         verify the reference reader in @greatcms/conformance",
      "",
      "<dir> holds one JSON file per region, named <region-id>.json, and — if the",
      "reader implements collections — <dir>/entries/<collection>/<slug>.json,",
      'each `{ "slug": …, "data": … }`. Collections are reported separately, so a',
      "regions-only reader still gets a useful answer.",
      "",
    ].join("\n"),
  );
  process.exit(command === "help" ? 0 : 1);
}

const { regions, entries } = args[0] === "--self" ? selfCheck() : verifyDirectory(args[0]);

const parts = [`${regions.checked} regions`];
if (entries) parts.push(`${entries.checked} entries`);
else parts.push("collections not implemented");

if (regions.ok && (!entries || entries.ok)) {
  process.stdout.write(`conformance: PASS (${parts.join(", ")})\n`);
  process.exit(0);
}

const failures = [...regions.failures, ...(entries?.failures ?? [])];
const count = `${failures.length} problem${failures.length === 1 ? "" : "s"}`;
process.stderr.write(`conformance: FAIL (${count} across ${parts.join(", ")})\n\n`);
for (const failure of failures) {
  process.stderr.write(`  ${failure.regionId}: ${failure.reason}\n`);
  if (failure.expected !== undefined) {
    process.stderr.write(`    expected: ${JSON.stringify(failure.expected)}\n`);
    process.stderr.write(`    actual:   ${JSON.stringify(failure.actual)}\n`);
  }
}
process.stderr.write("\n");
process.exit(1);

function selfCheck() {
  const found = {};
  for (const name of ["blog", "guides"]) {
    for (const entry of readFixtureEntries(name)) {
      found[`${name}/${entry.slug}`] = entry;
    }
  }
  return { regions: runConformance(readFixtureRegion), entries: verifyEntries(found) };
}

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

  const foundRegions = {};
  for (const file of readdirSync(abs)) {
    if (!file.endsWith(".json")) continue;
    foundRegions[file.slice(0, -".json".length)] = readJson(join(abs, file));
  }

  // Collections are optional surface: a reader that only does regions is still
  // worth verifying, and saying "not implemented" beats a misleading failure.
  const entriesDir = join(abs, "entries");
  if (!existsSync(entriesDir)) return { regions: verifyRegions(foundRegions), entries: null };

  const foundEntries = {};
  for (const collection of readdirSync(entriesDir)) {
    const collectionDir = join(entriesDir, collection);
    if (!statSync(collectionDir).isDirectory()) continue;
    for (const file of readdirSync(collectionDir)) {
      if (!file.endsWith(".json")) continue;
      foundEntries[`${collection}/${file.slice(0, -".json".length)}`] = readJson(
        join(collectionDir, file),
      );
    }
  }

  return { regions: verifyRegions(foundRegions), entries: verifyEntries(foundEntries) };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    process.stderr.write(`${path}: not valid JSON — ${err.message}\n`);
    process.exit(2);
  }
}
