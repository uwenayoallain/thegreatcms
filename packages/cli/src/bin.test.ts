/** The built binary itself, started as a person starts it. */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "./version.js";

const bin = fileURLToPath(new URL("../bin/greatcms.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("../../conformance/fixtures", import.meta.url));

function greatcms(args: string[], cwd = fixtures) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Every module the entry reaches without a dynamic import. */
function staticGraph(entry: URL, seen = new Set<string>()): Set<string> {
  if (seen.has(entry.href)) return seen;
  seen.add(entry.href);
  const source = readFileSync(entry, "utf8");
  for (const match of source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"/gm)) {
    const specifier = match[1]!;
    if (specifier.startsWith(".")) staticGraph(new URL(specifier, entry), seen);
    else seen.add(specifier);
  }
  return seen;
}

describe("the binary", () => {
  it("prints its version", () => {
    expect(greatcms(["--version"])).toEqual({ code: 0, out: `greatcms ${VERSION}\n`, err: "" });
  });

  it("prints help", () => {
    const { code, out } = greatcms(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage: greatcms <command>");
  });

  it("runs a command that needs the schema", () => {
    const { code, out } = greatcms(["describe", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toHaveProperty("regions");
  });

  it("exits 2 for a command it does not have, and 1 where there is no site", () => {
    expect(greatcms(["chekc"]).code).toBe(2);
    const outside = greatcms(["check"], fileURLToPath(new URL("../bin", import.meta.url)));
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("No .cms/schema.yaml found");
  });
});

describe("check, on a pattern that backtracks without end", () => {
  let site: string;
  beforeEach(() => {
    site = mkdtempSync(join(tmpdir(), "greatcms-check-pattern-"));
    mkdirSync(join(site, ".cms"));
    mkdirSync(join(site, "content/cms"), { recursive: true });
    writeFileSync(
      join(site, ".cms/schema.yaml"),
      'version: 1\nregions:\n  home.hero:\n    fields:\n      code: { type: text, pattern: "^(?=(a+)+$)" }\n      sku: { type: text, pattern: "^(a+){20}$" }\n',
    );
    writeFileSync(
      join(site, "content/cms/home.hero.json"),
      JSON.stringify({ code: `${"a".repeat(64)}!`, sku: `${"a".repeat(64)}!` }),
    );
  });
  afterEach(() => rmSync(site, { recursive: true, force: true }));

  it("stops, names the field and the pattern, and exits non-zero", () => {
    // The limit here only ends a run that hung; nothing is asserted about how long a good one takes.
    const result = spawnSync(process.execPath, [bin, "check", "--json"], {
      cwd: site,
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      issues: Array<Record<string, string>>;
    };
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(2);
    expect(report.issues[0]).toEqual({
      code: "pattern_timeout",
      file: "content/cms/home.hero.json",
      path: "code",
      message: "Could not be checked against pattern ^(?=(a+)+$) in time, so it was not accepted.",
      fix: expect.any(String),
    });
    expect(report.issues[1]).toMatchObject({ code: "pattern_timeout", path: "sku" });
  });

  it("says so in words too", () => {
    const { code, err } = greatcms(["check"], site);
    expect(code).toBe(1);
    expect(err).toContain("^(?=(a+)+$) in time");
  });
});

describe("start-up", () => {
  it("loads neither YAML nor the spec until a command needs them", () => {
    const graph = staticGraph(new URL("../dist/run.js", import.meta.url));
    expect([...graph].filter((id) => id === "yaml" || id.startsWith("@greatcms/"))).toEqual([]);
    expect([...graph].some((id) => id.includes("handlers"))).toBe(false);
  });
});
