/** `.cms/schema.yaml`: the file that tells the studio what a site's content looks like. */

import { parse as parseYaml } from "yaml";
import { IssueBag, SpecIssue } from "./errors.js";
import { type FieldDef, type SelectOption, parseFields, selectOption } from "./fields.js";
import {
  type Parser,
  type Problem,
  INVALID,
  count,
  describe,
  fail,
  isRecord,
  keyPath,
  list,
  mapping,
  object,
  oneOf,
  optional,
  positiveCount,
  record,
  required,
  string,
  withDefault,
} from "./shape.js";

export const SPEC_VERSION = 1;

/** Region ids double as file names, so they are restricted to safe characters. */
export const REGION_ID_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface BlockDef {
  label?: string;
  description?: string;
  /** Named looks of one block; an instance picks one as `_variant`, the first when it says nothing. */
  variants?: SelectOption[];
  fields: Record<string, FieldDef>;
}

export interface SingleRegion {
  type?: "single";
  label?: string;
  description?: string;
  fields: Record<string, FieldDef>;
  default?: Record<string, unknown>;
}

export interface BlocksRegion {
  type: "blocks";
  label?: string;
  description?: string;
  allow: string[];
  min?: number;
  max?: number;
  default?: Array<Record<string, unknown>>;
}

export type RegionDef = SingleRegion | BlocksRegion;

export interface CollectionDef {
  label?: string;
  /** Singular noun used for actions such as "Add product". */
  entryLabel?: string;
  description?: string;
  path: string;
  format: "markdown" | "mdx" | "json";
  /** Field whose value becomes the prose body. Ignored for `json`. */
  body?: string;
  /** Field used to derive the file name. Defaults to `title`, then the entry id. */
  slug?: string;
  fields: Record<string, FieldDef>;
}

const FIELDS_FIX = "Add `fields:` with at least one field, e.g. `heading: { type: text }`.";

const blockDef = object({
  label: optional(string()),
  description: optional(string()),
  variants: optional(
    list(selectOption, { nonEmpty: true, fix: "List at least one variant, or remove `variants`." }),
  ),
  fields: required(parseFields, FIELDS_FIX),
});

const singleRegion = object({
  type: optional(oneOf(["single", "blocks"])),
  label: optional(string()),
  description: optional(string()),
  fields: required(parseFields, FIELDS_FIX),
  default: optional(mapping),
});

const blocksRegion = object({
  type: required(oneOf(["blocks"])),
  label: optional(string()),
  description: optional(string()),
  allow: required(
    list(string(), { nonEmpty: true, fix: "Name at least one block defined under `blocks:`." }),
    "Name the blocks it may hold, e.g. `allow: [hero, text]`.",
  ),
  min: optional(count),
  max: optional(positiveCount),
  default: optional(list(mapping)),
});

/** `type: blocks` makes a block list; anything else is a region of fields. */
const regionDef: Parser<RegionDef> = (value, at, problems) => {
  const parse = isRecord(value) && value.type === "blocks" ? blocksRegion : singleRegion;
  const parsed = parse(value, at, problems);
  return parsed === INVALID ? INVALID : (parsed as unknown as RegionDef);
};

const collectionDef = object({
  label: optional(string()),
  entryLabel: optional(string()),
  description: optional(string()),
  path: required(
    string({ nonEmpty: true }),
    "Say which folder holds its entries, e.g. `path: content/blog`.",
  ),
  format: withDefault(oneOf(["markdown", "mdx", "json"]), () => "markdown"),
  body: optional(string()),
  slug: optional(string()),
  fields: required(parseFields, FIELDS_FIX),
});

const schemaFile = object({
  version: required(
    (value, at, problems) =>
      typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : fail(problems, at, `Expected a version number, found ${describe(value)}.`),
    `Start the file with \`version: ${SPEC_VERSION}\`.`,
  ),
  site: optional(
    object({
      name: optional(string()),
      /** BCP 47 tag for the content's language, e.g. `rw` or `fr-RW`; editors get spellcheck and direction for it. */
      locale: optional(
        string({
          pattern: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
          expected: "a BCP 47 language tag",
          fix: "Use a tag such as `en`, `rw` or `fr-RW`.",
        }),
      ),
    }),
  ),
  blocks: optional(record(blockDef)),
  regions: optional(record(regionDef)),
  collections: optional(record(collectionDef)),
});

interface SchemaFile {
  version: number;
  site?: { name?: string; locale?: string };
  blocks?: Record<string, BlockDef>;
  regions?: Record<string, RegionDef>;
  collections?: Record<string, CollectionDef>;
}

function readSchemaFile(raw: unknown, problems: Problem[]): SchemaFile | typeof INVALID {
  const parsed = schemaFile(raw, "", problems);
  return parsed === INVALID ? INVALID : (parsed as unknown as SchemaFile);
}

export interface CmsSchema {
  version: number;
  site?: { name?: string; locale?: string };
  blocks: Record<string, BlockDef>;
  regions: Record<string, RegionDef>;
  collections: Record<string, CollectionDef>;
}

/** A block's variants as value/label pairs, or none. */
export function blockVariants(def: BlockDef | undefined): Array<{ value: string; label: string }> {
  return (def?.variants ?? []).map((option) =>
    typeof option === "string"
      ? { value: option, label: option }
      : { value: option.value, label: option.label ?? option.value },
  );
}

export function isBlocksRegion(region: RegionDef): region is BlocksRegion {
  return (region as BlocksRegion).type === "blocks";
}

/** Fields of a region, or of one block within a blocks region. */
export function fieldsOf(
  schema: CmsSchema,
  regionOrBlock: RegionDef | BlockDef,
): Record<string, FieldDef> | null {
  if ("fields" in regionOrBlock) return regionOrBlock.fields;
  return null;
}

export interface ParseSchemaOptions {
  /** Repo-relative path used in error messages. */
  file?: string;
}

/** Parses and validates a schema file. */
export function parseSchema(source: string, opts: ParseSchemaOptions = {}): CmsSchema {
  const file = opts.file ?? ".cms/schema.yaml";
  const bag = new IssueBag(file);

  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    bag.add({
      code: "invalid_yaml",
      message: `File is not valid YAML: ${(err as Error).message}`,
      fix: "Check indentation: YAML requires spaces, never tabs.",
    });
    bag.throwIfAny("Could not read schema");
    /* c8 ignore next */
    throw err;
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    bag.add({
      code: "empty_schema",
      message: "Schema file is empty or is not a mapping.",
      fix: "Start the file with `version: 1` and add a `regions:` or `collections:` block.",
    });
    bag.throwIfAny("Could not read schema");
  }

  const problems: Problem[] = [];
  const data = readSchemaFile(raw, problems);
  if (data === INVALID) {
    for (const problem of problems) {
      bag.add({ code: "invalid_schema", ...problem, path: problem.path || undefined });
    }
    bag.throwIfAny("Schema is not valid");
    /* c8 ignore next */
    throw new Error("unreachable");
  }

  if (data.version !== SPEC_VERSION) {
    bag.add({
      code: "unsupported_version",
      path: "version",
      message: `Schema declares version ${data.version}, but this tool supports version ${SPEC_VERSION}.`,
      fix: `Set \`version: ${SPEC_VERSION}\`, or upgrade the tool reading it.`,
    });
  }

  // Lookups by name must never land on Object.prototype: a region called `constructor` is unknown.
  const blocks = withoutPrototype(data.blocks ?? {});
  const regions = withoutPrototype(data.regions ?? {});
  const collections = withoutPrototype(data.collections ?? {});

  for (const name of Object.keys(blocks)) {
    if (!NAME_RE.test(name)) {
      bag.add({
        code: "invalid_block_name",
        path: `blocks.${name}`,
        message: `Block name "${name}" must be lowercase letters, digits, "-" or "_".`,
        fix: "Rename it, e.g. `hero`, `cta-wide`.",
      });
    }
  }

  for (const [id, region] of Object.entries(regions)) {
    if (!REGION_ID_RE.test(id)) {
      bag.add({
        code: "invalid_region_id",
        path: `regions.${id}`,
        message: `Region id "${id}" is not usable as a file name.`,
        fix: "Use dot-separated lowercase segments, e.g. `home.hero` or `about.team`.",
      });
    }

    if (isBlocksRegion(region)) {
      for (const [i, allowed] of region.allow.entries()) {
        if (!(allowed in blocks)) {
          bag.add({
            code: "unknown_block",
            path: `regions.${id}.allow[${i}]`,
            message: `Region allows block "${allowed}", which is not defined.`,
            fix: `Add a \`blocks.${allowed}\` definition, or remove it from \`allow\`.`,
          });
        }
      }
      if (region.min !== undefined && region.max !== undefined && region.min > region.max) {
        bag.add({
          code: "impossible_bounds",
          path: `regions.${id}`,
          message: `min (${region.min}) is greater than max (${region.max}).`,
          fix: "Lower `min` or raise `max`.",
        });
      }
    } else if (Object.keys(region.fields).length === 0) {
      bag.add({
        code: "empty_region",
        path: `regions.${id}.fields`,
        message: "Region has no fields, so there is nothing to edit.",
        fix: "Add at least one field, or delete the region.",
      });
    }
  }

  for (const [name, collection] of Object.entries(collections)) {
    if (!NAME_RE.test(name)) {
      bag.add({
        code: "invalid_collection_name",
        path: `collections.${name}`,
        message: `Collection name "${name}" must be lowercase letters, digits, "-" or "_".`,
        fix: "Rename it, e.g. `blog`, `case-studies`.",
      });
    }
    if (collection.body && !(collection.body in collection.fields)) {
      bag.add({
        code: "unknown_body_field",
        path: `collections.${name}.body`,
        message: `\`body\` points at "${collection.body}", which is not one of this collection's fields.`,
        fix: `Add a \`${collection.body}\` field (usually \`type: richtext\`), or change \`body\`.`,
      });
    }
    if (collection.slug && !(collection.slug in collection.fields)) {
      bag.add({
        code: "unknown_slug_field",
        path: `collections.${name}.slug`,
        message: `\`slug\` points at "${collection.slug}", which is not one of this collection's fields.`,
        fix: `Add a \`${collection.slug}\` field, or change \`slug\`.`,
      });
    }
  }

  const collectionNames = Object.keys(collections);
  const checkReferences = (fields: Record<string, FieldDef>, at: string) =>
    eachField(fields, at, (def, path) => {
      if (def.type !== "reference" || def.collection in collections) return;
      bag.add({
        code: "unknown_collection",
        path: `${path}.collection`,
        message: `Field refers to collection "${def.collection}", which is not defined.`,
        fix:
          collectionNames.length > 0
            ? `Point \`collection\` at one of: ${collectionNames.join(", ")}; or add a \`collections.${def.collection}\` definition.`
            : `Add a \`collections.${def.collection}\` definition for the entries it points at.`,
      });
    });
  for (const [name, block] of Object.entries(blocks)) {
    checkReferences(block.fields, `blocks.${name}.fields`);
  }
  for (const [id, region] of Object.entries(regions)) {
    if (!isBlocksRegion(region)) checkReferences(region.fields, `regions.${id}.fields`);
  }
  for (const [name, collection] of Object.entries(collections)) {
    checkReferences(collection.fields, `collections.${name}.fields`);
  }

  if (Object.keys(regions).length === 0 && Object.keys(collections).length === 0) {
    bag.add({
      code: "nothing_managed",
      message: "Schema defines no regions and no collections.",
      fix: "Add a region: the smallest useful CMS is one managed hero section.",
    });
  }

  bag.throwIfAny("Schema is not valid");

  return { version: data.version, site: data.site, blocks, regions, collections };
}

/**
 * Keys the schema format does not define, such as a misspelt `requird: true`. Readers
 * ignore them, so a site written for a newer version still builds with an older
 * reader; authoring tools report them, because there a typo silently changes meaning.
 */
export function unknownSchemaKeys(source: string, opts: ParseSchemaOptions = {}): SpecIssue[] {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch {
    return [];
  }
  const parsed = readSchemaFile(raw, []);
  if (parsed === INVALID) return [];
  const issues: SpecIssue[] = [];
  const walk = (given: unknown, kept: unknown, path: string) => {
    if (Array.isArray(given) && Array.isArray(kept)) {
      given.forEach((item, index) => walk(item, kept[index], `${path}[${index}]`));
      return;
    }
    if (!isRecord(given) || !isRecord(kept)) return;
    for (const [key, value] of Object.entries(given)) {
      const at = path ? `${path}.${key}` : key;
      if (Object.hasOwn(kept, key)) {
        walk(value, kept[key], at);
      } else {
        issues.push(
          new SpecIssue({
            code: "unknown_schema_key",
            file: opts.file ?? ".cms/schema.yaml",
            path: at,
            message: `\`${key}\` is not a key the schema format defines, so it does nothing.`,
            fix: "Check it for a typo, or remove it.",
          }),
        );
      }
    }
  };
  walk(raw, parsed, "");
  return issues;
}

function withoutPrototype<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

/** Every field definition, depth first, including those inside groups and lists. */
export function eachField(
  fields: Record<string, FieldDef>,
  at: string,
  visit: (def: FieldDef, path: string) => void,
): void {
  for (const [name, def] of Object.entries(fields)) visitField(def, keyPath(at, name), visit);
}

function visitField(def: FieldDef, path: string, visit: (def: FieldDef, path: string) => void) {
  visit(def, path);
  if (def.type === "group") eachField(def.fields, `${path}.fields`, visit);
  if (def.type === "list") visitField(def.of, `${path}.of`, visit);
}
