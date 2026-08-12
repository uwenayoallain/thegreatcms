/**
 * Emits JSON Schema for `.cms/schema.yaml` and `.cms/config.yaml` from the Zod
 * definitions, so editors give authors autocomplete and inline validation
 * without this repo maintaining two descriptions of the same format.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { ConfigFileSchema } from '../dist/config.js';
import { SchemaFileSchema } from '../dist/schema.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'json-schema');
await mkdir(outDir, { recursive: true });

const targets = [
  {
    file: 'schema.schema.json',
    zod: SchemaFileSchema,
    name: 'GreatCMS schema',
    description: 'Content model for a site managed by GreatCMS (.cms/schema.yaml).',
  },
  {
    file: 'config.schema.json',
    zod: ConfigFileSchema,
    name: 'GreatCMS config',
    description: 'Repository layout and publishing settings for GreatCMS (.cms/config.yaml).',
  },
];

for (const target of targets) {
  const json = zodToJsonSchema(target.zod, {
    name: target.name,
    $refStrategy: 'root',
    target: 'jsonSchema7',
  });
  json.title = target.name;
  json.description = target.description;
  await writeFile(join(outDir, target.file), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`wrote json-schema/${target.file}`);
}
