/** The built binary itself, started as a person starts it. */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

describe("start-up", () => {
  it("loads neither YAML nor the spec until a command needs them", () => {
    const graph = staticGraph(new URL("../dist/run.js", import.meta.url));
    expect([...graph].filter((id) => id === "yaml" || id.startsWith("@greatcms/"))).toEqual([]);
    expect([...graph].some((id) => id.includes("handlers"))).toBe(false);
  });
});
