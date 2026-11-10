/** A setting the studio reads at start is one its documentation names. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const page = readFileSync(join(ROOT, "apps/docs/content/docs/running-the-studio.md"), "utf8");
const main = readFileSync(join(ROOT, "apps/studio/src/main.ts"), "utf8");

/** The first cell of each row in the page's environment table. */
const documented = new Set(
  [...page.matchAll(/^\| `([A-Z_]+)`\s+\|/gm)].map((match) => match[1] as string),
);

describe("the environment table", () => {
  it.each(["STUDIO_GITHUB_URL", "STUDIO_GITHUB_OWNERS", "STUDIO_OWNER_NAME"])(
    "has a row for %s, which the studio reads",
    (name) => {
      expect(main).toContain(`process.env.${name}`);
      expect(documented.has(name), [...documented].join(", ")).toBe(true);
    },
  );
});
