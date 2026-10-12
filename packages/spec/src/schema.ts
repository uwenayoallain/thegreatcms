/** `.cms/schema.yaml` — the file that tells the studio what a site's content looks like. */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { IssueBag, SpecIssue } from "./errors.js";
import { type FieldDef, FieldDefSchema, selectOption } from "./fields.js";

export const SPEC_VERSION = 1;

/** Region ids double as file names, so they are restricted to safe characters. */
export const REGION_ID_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

const regionId = z.string().regex(REGION_ID_RE);

const BlockDefSchema = z.object({
  label: z.string().optional(),
  description: z.string().optional(),
  /** Named looks of one block; an instance picks one as `_variant`, the first when it says nothing. */
  variants: z.array(selectOption).min(1).optional(),
  fields: z.record(FieldDefSchema),
});

const SingleRegionSchema = z.object({
  type: z.literal("single").optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  fields: z.record(FieldDefSchema),
  default: z.record(z.unknown()).optional(),
});

const BlocksRegionSchema = z.object({
  type: z.literal("blocks"),
  label: z.string().optional(),
  description: z.string().optional(),
  allow: z.array(z.string()).min(1),
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().positive().optional(),
  default: z.array(z.record(z.unknown())).optional(),
});

const CollectionSchema = z.object({
  label: z.string().optional(),
  /** Singular noun used for actions such as "Add product". */
  entryLabel: z.string().optional(),
  description: z.string().optional(),
  path: z.string().min(1),
  format: z.enum(["markdown", "mdx", "json"]).default("markdown"),
  /** Field whose value becomes the prose body. Ignored for `json`. */
  body: z.string().optional(),
  /** Field used to derive the file name. Defaults to `title`, then the entry id. */
  slug: z.string().optional(),
  fields: z.record(FieldDefSchema),
});

export const SchemaFileSchema = z.object({
  version: z.number().int().positive(),
  site: z
    .object({
      name: z.string().optional(),
      /** BCP 47 tag for the content's language, e.g. `rw` or `fr-RW`; editors get spellcheck and direction for it. */
      locale: z
        .string()
        .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
        .optional(),
    })
    .optional(),
  blocks: z.record(BlockDefSchema).optional(),
  regions: z.record(z.union([BlocksRegionSchema, SingleRegionSchema])).optional(),
  collections: z.record(CollectionSchema).optional(),
});

export type BlockDef = z.infer<typeof BlockDefSchema>;
export type SingleRegion = z.infer<typeof SingleRegionSchema> & { type?: "single" };
export type BlocksRegion = z.infer<typeof BlocksRegionSchema>;
export type RegionDef = SingleRegion | BlocksRegion;
export type CollectionDef = z.infer<typeof CollectionSchema>;

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
      fix: "Check indentation — YAML requires spaces, never tabs.",
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

  const parsed = SchemaFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      bag.add({
        code: "invalid_schema",
        path: issue.path.join(".") || undefined,
        message: issue.message,
        fix: fixHintFor(issue),
      });
    }
    bag.throwIfAny("Schema is not valid");
  }

  const data = parsed.data as z.infer<typeof SchemaFileSchema>;

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
  const regions = withoutPrototype((data.regions ?? {}) as Record<string, RegionDef>);
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
    if (!regionId.safeParse(id).success) {
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

  if (Object.keys(regions).length === 0 && Object.keys(collections).length === 0) {
    bag.add({
      code: "nothing_managed",
      message: "Schema defines no regions and no collections.",
      fix: "Add a region — the smallest useful CMS is one managed hero section.",
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
  const parsed = SchemaFileSchema.safeParse(raw);
  if (!parsed.success) return [];
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
  walk(raw, parsed.data, "");
  return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutPrototype<T>(record: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, record);
}

function fixHintFor(issue: z.ZodIssue): string | undefined {
  if (issue.code === "invalid_union_discriminator" || issue.code === "invalid_literal") {
    return "Check the `type:` value — see the field type list in the spec docs.";
  }
  if (issue.code === "unrecognized_keys") {
    return "Remove the unknown key, or check it for a typo.";
  }
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return "This key is required.";
  }
  return undefined;
}
