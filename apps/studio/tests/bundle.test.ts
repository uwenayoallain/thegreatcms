/** The built server must start from dist alone: the image ships no package.json or node_modules. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the server bundle", () => {
  it("reads no file beside it while loading, such as a bundled package's package.json", () => {
    const bundle = readFileSync(new URL("../dist/main.js", import.meta.url), "utf8");
    expect(bundle).not.toMatch(/new URL\(["']\.\.\/package\.json["']/);
  });
});
