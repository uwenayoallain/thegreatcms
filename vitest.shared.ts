/** Test settings every package shares, so `pnpm check` behaves the same whether one package runs or all of them. */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Turbo runs several packages at once; a worker per core in each of them starves the machine.
    maxWorkers: "50%",
    // Some tests launch Chromium, build a site, or start a CLI. Under a full parallel run that is
    // seconds, not milliseconds, and the 5 s default turned load into failures.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
