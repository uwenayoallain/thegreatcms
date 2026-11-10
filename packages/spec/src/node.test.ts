/** The Node-only time limit on patterns, and the main entry staying free of Node. */

import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseSchema, usePatternMatcher, validateRegion } from "./index.js";
import { boundedMatch, runsInLinearTime } from "./node.js";

/** Long enough that backtracking would outlast the test many times over. */
const HOSTILE = `${"a".repeat(64)}!`;

afterEach(() => usePatternMatcher(undefined));

describe("the time limit on a pattern", () => {
  it("stops a pattern the linear engine cannot run, and says nothing matched or failed", () => {
    expect(runsInLinearTime(/^(?=(a+)+$)/)).toBe(false);
    expect(boundedMatch(/^(?=(a+)+$)/, HOSTILE)).toBeNull();
  });

  it("still answers for ordinary patterns and for lookahead that finishes", () => {
    expect(runsInLinearTime(/^[a-z0-9-]{1,16}$/)).toBe(true);
    expect(boundedMatch(/^[a-z0-9-]{1,16}$/, "a-slug")).toBe(true);
    expect(boundedMatch(/^(?=.*[0-9]).{8,}$/, "password1")).toBe(true);
    expect(boundedMatch(/^(?=.*[0-9]).{8,}$/, "short")).toBe(false);
  });

  it("turns a stopped check into an issue naming the field and the pattern", () => {
    usePatternMatcher(boundedMatch);
    const schema = parseSchema(
      'version: 1\nregions:\n  home.hero:\n    fields:\n      code: { type: text, pattern: "^(?=(a+)+$)" }\n',
    );
    const [issue] = validateRegion(schema, "home.hero", { code: HOSTILE }).issues;

    expect(issue).toMatchObject({ code: "pattern_timeout", path: "code" });
    expect(issue?.message).toContain("^(?=(a+)+$)");
  });
});

describe("the main entry", () => {
  const built = new URL("../dist/index.js", import.meta.url);

  it.skipIf(!existsSync(built))("imports nothing from Node, so it runs anywhere", () => {
    expect(readFileSync(built, "utf8")).not.toMatch(/from\s*"node:|import\(?\s*"node:/);
  });
});
