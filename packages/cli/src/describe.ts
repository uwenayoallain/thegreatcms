/**
 * `greatcms describe`: the content model in one screen, for a person or a coding agent about to
 * write content. Every region, block and collection, each field's type and limits, and where the
 * files go, without reading YAML anchors or the standard first.
 */

import {
  blockVariants,
  isBlocksRegion,
  regionFilePath,
  selectOptions,
  type CmsConfig,
  type CmsSchema,
  type FieldDef,
} from "@greatcms/spec";

export interface DescribedField {
  name: string;
  type: string;
  required: boolean;
  /** Everything else that constrains a value, as short phrases: "≤ 80 chars", "one of a | b". */
  rules: string[];
  /** The schema's own words for it, often the most useful hint of all. */
  description?: string;
}

export interface SiteDescription {
  site?: string;
  locale?: string;
  media: { dir: string; url: string };
  regions: Array<{
    id: string;
    label?: string;
    file: string;
    edited: boolean;
    blocks?: string[];
    fields?: DescribedField[];
  }>;
  blocks: Array<{ name: string; label?: string; variants?: string[]; fields: DescribedField[] }>;
  collections: Array<{
    name: string;
    label?: string;
    file: string;
    format: string;
    preview?: string;
    entries: string[];
    fields: DescribedField[];
  }>;
}

export function describeSite(options: {
  schema: CmsSchema;
  config: CmsConfig;
  /** Slugs that exist, per collection. */
  entries: Record<string, string[]>;
  /** Regions with a content file. */
  edited: Set<string>;
}): SiteDescription {
  const { schema, config, entries, edited } = options;
  const extension = { markdown: "md", mdx: "mdx", json: "json" } as const;
  return {
    site: schema.site?.name,
    locale: schema.site?.locale,
    media: { dir: config.content.media, url: config.mediaUrlPrefix },
    regions: Object.entries(schema.regions).map(([id, region]) => ({
      id,
      label: region.label,
      file: regionFilePath(config, id),
      edited: edited.has(id),
      blocks: isBlocksRegion(region) ? region.allow : undefined,
      fields: isBlocksRegion(region) ? undefined : describeFields(region.fields),
    })),
    blocks: Object.entries(schema.blocks).map(([name, block]) => {
      const variants = blockVariants(block).map((variant) => variant.value);
      return {
        name,
        label: block.label,
        variants: variants.length > 0 ? variants : undefined,
        fields: describeFields(block.fields),
      };
    }),
    collections: Object.entries(schema.collections).map(([name, collection]) => {
      const paths = config.preview?.paths?.[name];
      const preview = typeof paths === "string" ? paths : paths?.["*"];
      return {
        name,
        label: collection.label,
        file: `${collection.path.replace(/\/+$/, "")}/<slug>.${extension[collection.format]}`,
        format: collection.format,
        preview: preview || undefined,
        entries: (entries[name] ?? []).toSorted(),
        fields: describeFields(collection.fields),
      };
    }),
  };
}

function describeFields(fields: Record<string, FieldDef>): DescribedField[] {
  return Object.entries(fields).map(([name, def]) => ({
    name,
    type: typeOf(def),
    required: Boolean(def.required),
    rules: rulesOf(def),
    description: def.description || undefined,
  }));
}

function typeOf(def: FieldDef): string {
  switch (def.type) {
    case "list":
      return `list<${typeOf(def.of)}>`;
    case "blocks":
      return `blocks<${def.allow.join(" | ")}>`;
    case "reference":
      return def.multiple ? `reference<${def.collection}>[]` : `reference<${def.collection}>`;
    case "select":
      return def.multiple ? "select[]" : "select";
    case "text":
      return def.multiline ? "text (multiline)" : "text";
    default:
      return def.type;
  }
}

function rulesOf(def: FieldDef): string[] {
  const rules: string[] = [];
  const bounds = (min?: number, max?: number, unit = "") => {
    if (min !== undefined && max !== undefined) rules.push(`${min}–${max}${unit}`);
    else if (max !== undefined) rules.push(`≤ ${max}${unit}`);
    else if (min !== undefined) rules.push(`≥ ${min}${unit}`);
  };
  switch (def.type) {
    case "text":
      bounds(def.min, def.max, " chars");
      if (def.pattern) rules.push(`matches /${def.pattern}/`);
      break;
    case "number":
      bounds(def.min, def.max);
      if (def.integer) rules.push("whole number");
      break;
    case "select":
      rules.push(
        `one of ${selectOptions(def)
          .map((option) => option.value)
          .join(" | ")}`,
      );
      break;
    case "list":
    case "blocks":
      bounds(def.min, def.max, " items");
      break;
    case "image":
      rules.push(def.alt === "decorative-allowed" ? "alt may be empty" : "alt required");
      break;
    case "group":
      rules.push(`{ ${describeFields(def.fields).map(signature).join(", ")} }`);
      break;
    default:
      break;
  }
  if (def.when) {
    const when = def.when.in ? def.when.in.join(" | ") : String(def.when.equals);
    rules.push(`only when ${def.when.field} is ${when}`);
  }
  if ("default" in def && def.default !== undefined)
    rules.push(`default ${JSON.stringify(def.default)}`);
  return rules;
}

function signature(field: DescribedField): string {
  const rules = field.rules.length ? ` (${field.rules.join("; ")})` : "";
  const hint = field.description ? `  # ${field.description}` : "";
  return `${field.name}${field.required ? "!" : ""}: ${field.type}${rules}${hint}`;
}

/** The outline as text: one line per field, `!` for required. */
export function formatDescription(description: SiteDescription): string {
  const lines: string[] = [];
  const head = [description.site, description.locale && `(${description.locale})`]
    .filter(Boolean)
    .join(" ");
  if (head) lines.push(head);
  lines.push(
    `media: files in ${description.media.dir}, referenced as ${description.media.url}/<file>`,
    "",
  );

  for (const region of description.regions) {
    lines.push(
      `region ${region.id} → ${region.file}${region.edited ? "" : "  (not yet written: schema defaults)"}`,
    );
    if (region.blocks)
      lines.push(`  {"blocks": [{"_type": ${region.blocks.map((b) => `"${b}"`).join(" | ")}, …}]}`);
    for (const field of region.fields ?? []) lines.push(`  ${signature(field)}`);
  }
  if (description.blocks.length > 0) lines.push("");
  for (const block of description.blocks) {
    lines.push(
      `block ${block.name}${block.variants ? `  _variant: ${block.variants.join(" | ")} (first is the default)` : ""}`,
    );
    for (const field of block.fields) lines.push(`  ${signature(field)}`);
  }
  if (description.collections.length > 0) lines.push("");
  for (const collection of description.collections) {
    lines.push(
      `collection ${collection.name} → ${collection.file}${collection.preview ? `  page ${collection.preview}` : ""}`,
    );
    lines.push(
      `  entries: ${collection.entries.length > 0 ? collection.entries.join(", ") : "none yet"}`,
    );
    for (const field of collection.fields) lines.push(`  ${signature(field)}`);
  }
  lines.push(
    "",
    "`!` is required. Images are {src, alt, width?, height?}; links {href, label?, external?}; rich text {html}.",
    "Write the files, then run `greatcms check`.",
  );
  return `${lines.join("\n")}\n`;
}
