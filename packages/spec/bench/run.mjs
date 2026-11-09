/** `pnpm bench`: parsing, validation and resolution on a site far larger than a real one. */

import {
  parseFrontmatter,
  parseRegionFile,
  parseSchema,
  resolveRegion,
  serializeRegion,
  unknownSchemaKeys,
  validateRegion,
} from "../dist/index.js";
import {
  blocksDocument,
  entrySource,
  fieldValues,
  report,
  schemaSource,
  time,
} from "./fixtures.mjs";

const SIZE = 300;
const source = schemaSource(SIZE);
const schema = parseSchema(source);
const regionIds = Object.keys(schema.regions);
const single = regionIds.filter((id) => id.endsWith(".hero"));
const blocksDoc = blocksDocument(0, SIZE, 2000);
const blocksJson = serializeRegion(blocksDoc);
const stored = Object.fromEntries(single.map((id, i) => [id, fieldValues(i)]));
const entries = Array.from({ length: 2000 }, (_, i) => entrySource(i));
const kb = (text) => `${(text.length / 1024).toFixed(0)} KB`;

report([
  [`parseSchema (${kb(source)}, ${SIZE * 3} definitions)`, time(() => parseSchema(source), 5)],
  ["unknownSchemaKeys (same file)", time(() => unknownSchemaKeys(source), 5)],
  [
    `resolveRegion x ${regionIds.length} (no content file)`,
    time(() => {
      for (const id of regionIds) resolveRegion(schema, id, null);
    }),
  ],
  [
    `resolveRegion x ${single.length} (stored content)`,
    time(() => {
      for (const id of single) resolveRegion(schema, id, stored[id]);
    }),
  ],
  ["resolveRegion, 2000 blocks", time(() => resolveRegion(schema, "page0.body", blocksDoc))],
  ["validateRegion, 2000 blocks", time(() => validateRegion(schema, "page0.body", blocksDoc))],
  [
    `validateRegion x ${single.length} (strict)`,
    time(() => {
      for (const id of single) validateRegion(schema, id, stored[id], { strict: true });
    }),
  ],
  [`parseRegionFile (${kb(blocksJson)})`, time(() => parseRegionFile(blocksJson, "x.json"))],
  ["serializeRegion, 2000 blocks", time(() => serializeRegion(blocksDoc))],
  [
    "parseFrontmatter x 2000",
    time(() => {
      for (const entry of entries) parseFrontmatter(entry);
    }, 5),
  ],
]);
