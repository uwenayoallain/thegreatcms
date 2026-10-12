/** Files the site publishes straight from the repository, so they cannot drift from it. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "../..");

export function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}
