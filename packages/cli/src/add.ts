/** `greatcms add` — put a new managed section into a schema that already exists. */

import {
  hasFrontmatter,
  isBlocksRegion,
  isSafeSlug,
  type CollectionFormat,
  parseSchema,
  REGION_ID_RE,
  type CmsConfig,
  type CmsSchema,
} from "@greatcms/spec";
import type { Framework } from "./detect.js";
import { isMap, isSeq, parse as parseYaml, parseDocument } from "yaml";

export class AddError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(fix ? `${message}\n  fix: ${fix}` : message);
    this.name = "AddError";
  }
}

export type FieldType =
  | "text"
  | "richtext"
  | "number"
  | "boolean"
  | "date"
  | "link"
  | "image"
  | "file"
  | "select"
  | "list"
  | "group"
  | "blocks";

export const FIELD_TYPES: Array<{ id: FieldType; hint: string }> = [
  { id: "text", hint: "a single line, or several with --multiline" },
  { id: "richtext", hint: "formatted prose, edited visually" },
  { id: "image", hint: "an upload, with alt text required" },
  { id: "link", hint: "a URL and its label" },
  { id: "number", hint: "a number" },
  { id: "boolean", hint: "a checkbox" },
  { id: "date", hint: "an ISO date" },
  { id: "select", hint: "one of a fixed set — write it as name:select(a|b)" },
  { id: "file", hint: "any uploaded file" },
  { id: "list", hint: "repeatable — write it as name:list(text)" },
  { id: "group", hint: "related fields — build them interactively with greatcms setup" },
  { id: "blocks", hint: "nested components — write it as name:blocks(card|grid)" },
];

export interface FieldSpec {
  name: string;
  type: FieldType;
  required: boolean;
  label?: string;
  multiline?: boolean;
  default?: string | number | boolean;
  /** For select. */
  options?: string[];
  /** For list. */
  of?: FieldType;
  /** For blocks: the block names this field may hold. */
  allow?: string[];
  /** Related fields inside a group. */
  fields?: FieldSpec[];
}

const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;

/**
 * `heading:text!` — one field, in one argument. The shape earns its keep: it
 * is the difference between `greatcms add region home.hero --field heading:text!`
 * and a paragraph of YAML you have to indent correctly by hand.
 */
export function parseFieldSpec(input: string): FieldSpec {
  const match = /^([^:]+):([a-z]+)(\(([^)]*)\))?(!)?$/.exec(input.trim());
  if (!match) {
    throw new AddError(
      `Cannot read the field "${input}".`,
      "Write it as name:type, e.g. heading:text, body:richtext!, style:select(primary|secondary).",
    );
  }

  const [, rawName = "", rawType = "", , argument, bang] = match;
  const name = rawName.trim();

  if (!FIELD_NAME_RE.test(name)) {
    throw new AddError(
      `"${name}" is not a usable field name.`,
      "Start with a lowercase letter, then letters, digits, or underscores.",
    );
  }

  const type = rawType as FieldType;
  if (!FIELD_TYPES.some((entry) => entry.id === type)) {
    throw new AddError(
      `"${rawType}" is not a field type.`,
      `Choose one of: ${FIELD_TYPES.map((entry) => entry.id).join(", ")}.`,
    );
  }

  const field: FieldSpec = { name, type, required: bang === "!" };

  if (type === "group") {
    throw new AddError(
      "Groups need nested field definitions.",
      "Use greatcms setup to build grouped fields interactively.",
    );
  }

  if (type === "select") {
    const options = (argument ?? "")
      .split("|")
      .map((option) => option.trim())
      .filter(Boolean);
    if (options.length < 2) {
      throw new AddError(
        `The select field "${name}" needs at least two options.`,
        `Write it as ${name}:select(primary|secondary).`,
      );
    }
    field.options = options;
  }

  if (type === "blocks") {
    const allow = (argument ?? "")
      .split("|")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (allow.length === 0) {
      throw new AddError(
        `The blocks field "${name}" needs at least one block type it may hold.`,
        `Write it as ${name}:blocks(card|grid).`,
      );
    }
    field.allow = allow;
    return field;
  }

  if (type === "list") {
    const inner = (argument ?? "text").trim() as FieldType;
    if (
      !FIELD_TYPES.some((entry) => entry.id === inner) ||
      ["list", "group", "select", "blocks"].includes(inner)
    ) {
      throw new AddError(
        `The list field "${name}" needs an item type it can hold.`,
        `Write it as ${name}:list(text).`,
      );
    }
    field.of = inner;
  }

  return field;
}

/** What a region looks like once a person has answered every question. */
export interface RegionPlan {
  kind: "region";
  id: string;
  label: string;
  fields: FieldSpec[];
  /** Set instead of fields when this is a reorderable block list. */
  allow?: string[];
}

export interface BlockPlan {
  kind: "block";
  name: string;
  label: string;
  fields: FieldSpec[];
  /** A blocks region that should offer this block immediately. */
  to?: string;
}

export interface CollectionPlan {
  kind: "collection";
  name: string;
  label: string;
  path: string;
  format: CollectionFormat;
  fields: FieldSpec[];
  /** The field holding the Markdown body. */
  body?: string;
  slug?: string;
  entryLabel?: string;
}

export type AddPlan = RegionPlan | BlockPlan | CollectionPlan;

export function validatePlan(plan: AddPlan, schema: CmsSchema): void {
  if (plan.kind === "region") {
    if (!REGION_ID_RE.test(plan.id)) {
      throw new AddError(
        `"${plan.id}" is not a usable region id.`,
        'Use dot-separated lowercase segments, e.g. "home.hero" or "about.intro".',
      );
    }
    if (schema.regions[plan.id]) {
      throw new AddError(
        `This schema already has a region called "${plan.id}".`,
        "Pick another id, or edit the existing one in .cms/schema.yaml.",
      );
    }
    for (const type of plan.allow ?? []) {
      assertBlockExists(type, schema);
    }
    assertNestedBlocksExist(plan.fields, schema);
    return;
  }

  if (plan.kind === "block") {
    if (!isSafeSlug(plan.name) || !/^[a-z][a-z0-9-]*$/.test(plan.name)) {
      throw new AddError(
        `"${plan.name}" is not a usable block name.`,
        "Use lowercase letters, digits, and hyphens.",
      );
    }
    if (schema.blocks[plan.name]) {
      throw new AddError(`This schema already has a block called "${plan.name}".`);
    }
    if (plan.to) {
      const target = schema.regions[plan.to];
      if (!target) {
        throw new AddError(
          `This schema has no region called "${plan.to}".`,
          `Choose a blocks region: ${blocksRegionIds(schema).join(", ") || "none are defined yet"}.`,
        );
      }
      if (!isBlocksRegion(target)) {
        throw new AddError(
          `The region "${plan.to}" is a field form, not a reorderable section list.`,
          "Choose a region whose schema has `type: blocks`.",
        );
      }
    }
    assertNestedBlocksExist(plan.fields, schema);
    return;
  }

  if (!/^[a-z][a-z0-9-]*$/.test(plan.name)) {
    throw new AddError(
      `"${plan.name}" is not a usable collection name.`,
      "Use lowercase letters, digits, and hyphens.",
    );
  }
  if (schema.collections[plan.name]) {
    throw new AddError(`This schema already has a collection called "${plan.name}".`);
  }
  assertNestedBlocksExist(plan.fields, schema);
}

function assertBlockExists(type: string, schema: CmsSchema): void {
  if (schema.blocks[type]) return;
  throw new AddError(
    `This schema has no block type called "${type}".`,
    `Add it first: greatcms add block ${type} --field title:text!`,
  );
}

/** A nested blocks field naming a type nobody defined would fail at edit time, not now. */
function assertNestedBlocksExist(fields: FieldSpec[], schema: CmsSchema): void {
  for (const field of fields) {
    for (const type of field.allow ?? []) assertBlockExists(type, schema);
    if (field.fields) assertNestedBlocksExist(field.fields, schema);
  }
}

/** The YAML for one entry, indented to sit under its top-level section. */
export function renderPlan(plan: AddPlan): string {
  const lines: string[] = [];

  if (plan.kind === "region") {
    lines.push(`  ${plan.id}:`, `    label: ${quote(plan.label)}`);
    if (plan.allow) {
      lines.push(
        "    # A blocks region is an ordered list an editor can add to and reorder.",
        "    type: blocks",
        `    allow: [${plan.allow.join(", ")}]`,
      );
    } else {
      lines.push("    fields:", ...plan.fields.map((field) => `      ${renderField(field)}`));
      const defaults = plan.fields.filter(defaultable);
      if (defaults.length > 0) {
        lines.push(
          "    # Rendered until someone edits it, so the site is never blank.",
          "    default:",
          ...defaults.map(
            (field) => `      ${field.name}: ${quote(placeholder(field, plan.label))}`,
          ),
        );
      }
    }
    return `${lines.join("\n")}\n`;
  }

  if (plan.kind === "block") {
    lines.push(
      `  ${plan.name}:`,
      `    label: ${quote(plan.label)}`,
      "    fields:",
      ...plan.fields.map((field) => `      ${renderField(field)}`),
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    `  ${plan.name}:`,
    `    label: ${quote(plan.label)}`,
    `    path: ${quote(plan.path)}`,
    `    format: ${plan.format}`,
  );
  if (hasFrontmatter(plan.format) && plan.body) {
    lines.push(`    body: ${plan.body}`);
  }
  if (plan.entryLabel) lines.push(`    entryLabel: ${quote(plan.entryLabel)}`);
  const slug = plan.slug ?? plan.fields.find((field) => field.name === "title")?.name;
  if (slug) lines.push(`    slug: ${slug}`);
  lines.push("    fields:", ...plan.fields.map((field) => `      ${renderField(field)}`));
  return `${lines.join("\n")}\n`;
}

function renderField(field: FieldSpec): string {
  const parts = [`type: ${field.type}`];
  if (field.required) parts.push("required: true");
  if (field.label) parts.push(`label: ${JSON.stringify(field.label)}`);
  if (field.multiline) parts.push("multiline: true");
  if (field.default !== undefined) parts.push(`default: ${JSON.stringify(field.default)}`);
  if (field.options)
    parts.push(`options: [${field.options.map((value) => JSON.stringify(value)).join(", ")}]`);
  if (field.of) parts.push(`of: { type: ${field.of} }`);
  if (field.allow) parts.push(`allow: [${field.allow.join(", ")}]`);
  if (field.fields) parts.push(`fields: { ${field.fields.map(renderField).join(", ")} }`);
  return `${field.name}: { ${parts.join(", ")} }`;
}

/** Only types whose placeholder is worth writing: a default nobody wants is noise. */
function defaultable(field: FieldSpec): boolean {
  return field.type === "text" && field.required && field.default === undefined;
}

function placeholder(field: FieldSpec, label: string): string {
  return field.name === "heading" || field.name === "title" ? label : `Edit this in the studio`;
}

/** Which top-level section an entry belongs under. */
export function sectionFor(plan: AddPlan): "regions" | "blocks" | "collections" {
  return plan.kind === "region" ? "regions" : plan.kind === "block" ? "blocks" : "collections";
}

/**
 * Inserts an entry into a schema file as text rather than by re-serializing it.
 * A schema is written by hand and full of comments explaining the site's own
 * decisions; parsing and dumping it would silently throw all of that away.
 */
export function insertIntoSchema(source: string, section: string, entry: string): string {
  const lines = source.split("\n");
  const header = lines.findIndex((line) => line === `${section}:`);

  if (header === -1) {
    const trimmed = source.replace(/\n+$/, "");
    return `${trimmed}\n\n${section}:\n${entry}`;
  }

  // The section ends at the next line that starts a new top-level key.
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || /^\s/.test(line)) continue;
    if (line.startsWith("#")) continue;
    end = i;
    break;
  }

  // Back up over the blank lines and comments that belong to whatever comes next.
  let insertAt = end;
  while (insertAt > header + 1) {
    const line = lines[insertAt - 1] ?? "";
    if (line.trim() === "" || line.startsWith("#")) insertAt -= 1;
    else break;
  }

  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const spacer = before.at(-1)?.trim() === "" ? [] : [""];

  return [...before, ...spacer, ...entry.replace(/\n$/, "").split("\n"), ...after].join("\n");
}

export interface AddResult {
  /** The schema file, with the new entry in it. */
  schema: string;
  /** Where the content file will live, once someone edits it. */
  contentPath: string | null;
}

/** Writes the entry into the schema and refuses to hand back anything that will not parse. */
export function applyPlan(options: {
  plan: AddPlan;
  source: string;
  file: string;
  config: CmsConfig;
}): AddResult {
  const { plan, source, file, config } = options;
  const schema = parseSchema(source, { file });
  validatePlan(plan, schema);

  let updated = file.endsWith(".json") ? source : addToYaml(source, plan, file);

  if (file.endsWith(".json")) {
    const document = JSON.parse(source);
    const section = sectionFor(plan);
    document[section] = { ...document[section], ...parseYaml(renderPlan(plan)) };
    if (plan.kind === "block" && plan.to) {
      const allow = document.regions[plan.to].allow;
      if (!allow.includes(plan.name)) allow.push(plan.name);
    }
    updated = `${JSON.stringify(document, null, 2)}\n`;
  }

  // Generating something our own parser rejects would be a cruel way to end a command.
  try {
    parseSchema(updated, { file });
  } catch (error) {
    throw new AddError(
      `Adding this would leave ${file} invalid: ${(error as Error).message}`,
      "This is a bug in `greatcms add`. Nothing was written.",
    );
  }

  return {
    schema: updated,
    contentPath:
      plan.kind === "region"
        ? `${config.content.regions.replace(/\/+$/, "")}/${plan.id}.json`
        : plan.kind === "collection"
          ? plan.path
          : null,
  };
}

/**
 * Adds the entry to YAML. The text edit leaves every byte of a hand-written schema
 * alone, but it assumes two-space indentation; when its result does not parse, the
 * same change goes through the parsed document instead, which still keeps comments.
 * Windows line endings come back the way they went in.
 */
function addToYaml(source: string, plan: AddPlan, file: string): string {
  const crlf = source.includes("\r\n");
  const text = crlf ? source.replaceAll("\r\n", "\n") : source;
  let updated: string;
  try {
    const inserted = insertIntoSchema(text, sectionFor(plan), renderPlan(plan));
    updated =
      plan.kind === "block" && plan.to
        ? attachBlockToRegion(inserted, plan.to, plan.name)
        : inserted;
    parseSchema(updated, { file });
  } catch {
    updated = addThroughDocument(text, plan);
  }
  return crlf ? updated.replaceAll("\n", "\r\n") : updated;
}

function addThroughDocument(text: string, plan: AddPlan): string {
  const document = parseDocument(text);
  const section = sectionFor(plan);
  if (!isMap(document.get(section, true))) document.set(section, document.createNode({}));
  const map = document.get(section, true);
  // `regions: {}` would otherwise grow into one long inline mapping.
  if (isMap(map)) map.flow = false;
  for (const [key, value] of Object.entries(
    parseYaml(renderPlan(plan)) as Record<string, unknown>,
  )) {
    document.setIn([section, key], document.createNode(value));
  }
  if (plan.kind === "block" && plan.to) {
    const allow = document.getIn(["regions", plan.to, "allow"], true);
    if (!isSeq(allow)) {
      throw new AddError(
        `The region "${plan.to}" has no allow list to update.`,
        "Nothing was written. Check that it has `type: blocks` and `allow: [...]`.",
      );
    }
    if (
      !allow.items.some((item) => String((item as { value?: unknown }).value ?? item) === plan.name)
    )
      allow.add(document.createNode(plan.name));
  }
  return document.toString();
}

/** Blocks regions are the places a top-level section can be offered to editors. */
export function blocksRegionIds(schema: CmsSchema): string[] {
  return Object.entries(schema.regions)
    .filter(([, region]) => isBlocksRegion(region))
    .map(([id]) => id);
}

/**
 * Adds a block name to one existing allow list without re-serializing the
 * schema. The rest of the file, including its comments, remains byte-for-byte.
 */
export function attachBlockToRegion(source: string, regionId: string, blockName: string): string {
  const lines = source.split("\n");
  const escaped = regionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entry = new RegExp(`^  (["']?)${escaped}\\1:\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => entry.test(line));
  if (start === -1) {
    throw new AddError(
      `Could not locate the region "${regionId}" in the schema text.`,
      "Nothing was written. Add the block to that region's `allow` list by hand.",
    );
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^  \S/.test(line) || /^\S/.test(line)) {
      end = index;
      break;
    }
  }

  const allowAt = lines.findIndex(
    (line, index) => index > start && index < end && /^    allow\s*:/.test(line),
  );
  if (allowAt === -1) {
    throw new AddError(
      `The region "${regionId}" has no allow list to update.`,
      "Nothing was written. Check that it has `type: blocks` and `allow: [...]`.",
    );
  }

  const allowLine = lines[allowAt] ?? "";
  const inline = /^(\s*allow\s*:\s*\[)(.*)(\]\s*(?:#.*)?)$/.exec(allowLine);
  if (inline) {
    const existing = inline[2]?.trim() ?? "";
    lines[allowAt] = `${inline[1]}${existing}${existing ? ", " : ""}${blockName}${inline[3]}`;
    return lines.join("\n");
  }

  if (/^    allow\s*:\s*(?:#.*)?$/.test(allowLine)) {
    let insertAt = allowAt + 1;
    while (insertAt < end && /^(?:\s{6,}|\s*$|\s*#)/.test(lines[insertAt] ?? "")) {
      insertAt += 1;
    }
    lines.splice(insertAt, 0, `      - ${blockName}`);
    return lines.join("\n");
  }

  throw new AddError(
    `The allow list for "${regionId}" uses a layout this command cannot safely edit.`,
    `Nothing was written. Add ${blockName} to that allow list by hand.`,
  );
}

/** The code that reads the new section, written out so nobody has to guess it. */
export function readSnippet(plan: AddPlan, framework: Framework, config: CmsConfig): string | null {
  if (plan.kind !== "region") return null;

  const dir = config.content.regions;
  if (plan.allow) {
    return [
      'import { createReader } from "@greatcms/reader";',
      "",
      "const cms = createReader();",
      `const blocks = cms.region("${plan.id}").blocks;`,
      "",
      "// Each block carries its own _type, so render them by type in order.",
    ].join("\n");
  }

  return framework.snippet(plan.id, dir);
}

/** Quotes only when YAML would otherwise misread the value: `2024`, `true` and `null` are not text. */
export function quote(value: string): string {
  const plain = /^[\w][\w \-.]*$/.test(value) && parseYaml(value) === value;
  return plain ? value : JSON.stringify(value);
}

/** A label a person would have typed, derived from the id they did type. */
export function labelFor(id: string): string {
  const words = id.split(/[.\-_]/).filter(Boolean);
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}
