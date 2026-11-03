/** This CLI's version, read from its own package.json so a release cannot forget to bump it. */

import { readFileSync } from "node:fs";

export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
