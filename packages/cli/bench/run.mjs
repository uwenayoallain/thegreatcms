/** `pnpm bench`: start-up cost of the binary, and `check` and `types` on a big site. */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeSite } from "../../reader/bench/site.mjs";

const bin = fileURLToPath(new URL("../bin/greatcms.mjs", import.meta.url));
const example = fileURLToPath(new URL("../../../examples/site-astro", import.meta.url));

/** Median wall time of the command over `runs` fresh processes. */
function spawn(args, cwd, runs = 9) {
  const samples = [];
  for (let i = 0; i <= runs; i++) {
    const start = performance.now();
    try {
      execFileSync(process.execPath, [bin, ...args], { cwd, stdio: "ignore" });
    } catch {
      // `check` exits 1 on a site with problems; the time is what is measured.
    }
    if (i > 0) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const big = writeSite({ regions: 60, entries: 1000 });
const rows = [];
try {
  rows.push(["node -e 0 (the floor)", spawnNode()]);
  rows.push(["greatcms --version", spawn(["--version"], example)]);
  rows.push(["greatcms --help", spawn(["--help"], example)]);
  rows.push(["greatcms check (small site)", spawn(["check"], example)]);
  rows.push(["greatcms types --stdout (small site)", spawn(["types", "--stdout"], example)]);
  rows.push(["greatcms describe (small site)", spawn(["describe"], example)]);
  rows.push(["greatcms check (60 regions, 4000 entries)", spawn(["check"], big, 3)]);
  rows.push(["greatcms check --json (same)", spawn(["check", "--json"], big, 3)]);
  rows.push(["greatcms types --stdout (same)", spawn(["types", "--stdout"], big, 3)]);
} finally {
  rmSync(big, { recursive: true, force: true });
}

function spawnNode() {
  const samples = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    execFileSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[4];
}

const width = Math.max(...rows.map(([name]) => name.length));
for (const [name, ms] of rows)
  console.log(`${name.padEnd(width)}  ${ms.toFixed(1).padStart(8)} ms`);
