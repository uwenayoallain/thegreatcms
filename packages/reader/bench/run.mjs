/** `pnpm bench`: what a build pays to read a site of 60 regions and 4000 entries. */

import { rmSync } from "node:fs";
import { createReader } from "../dist/index.js";
import { writeSite } from "./site.mjs";

const root = writeSite({ regions: 60, entries: 1000 });
const rows = [];
const once = (name, fn) => {
  const start = performance.now();
  const result = fn();
  rows.push([name, performance.now() - start]);
  return result;
};

try {
  const cms = once("createReader(), first in the process", () =>
    createReader({ root, drafts: false }),
  );
  const ids = cms.regionIds();

  once(`region() x ${ids.length}, cold`, () => ids.forEach((id) => cms.region(id)));
  once(`region() x ${ids.length}, warm`, () => ids.forEach((id) => cms.region(id)));
  once("collection() x 4 (4000 entries), cold", () => {
    for (const name of ["blog", "notes", "people", "products"]) cms.collection(name);
  });
  once("collection() x 4, warm", () => {
    for (const name of ["blog", "notes", "people", "products"]) cms.collection(name);
  });

  // What the scaffolded pages do: a new reader wherever content is needed.
  once("createReader().region() x 500 (a reader per page)", () => {
    for (let i = 0; i < 500; i++) createReader({ root, drafts: false }).region(ids[i % ids.length]);
  });
  once("createReader().collection('blog') x 50 (a reader per page)", () => {
    for (let i = 0; i < 50; i++) createReader({ root, drafts: false }).collection("blog");
  });

  const dev = createReader({ root, drafts: true });
  once(`region() x ${ids.length} in development`, () => ids.forEach((id) => dev.region(id)));
  once("collection('blog') in development", () => dev.collection("blog"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const width = Math.max(...rows.map(([name]) => name.length));
for (const [name, ms] of rows)
  console.log(`${name.padEnd(width)}  ${ms.toFixed(2).padStart(9)} ms`);
