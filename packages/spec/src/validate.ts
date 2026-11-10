/** Content validation. */

import { SpecIssue, boundedDepth } from "./errors.js";
import { conditionMet, type FieldDef, selectOptions } from "./fields.js";
import { isSafeSlug } from "./paths.js";
import { clip, own } from "./shape.js";
import { isSafeUrl } from "./urls.js";
import {
  type BlockDef,
  type CmsSchema,
  type RegionDef,
  blockVariants,
  isBlocksRegion,
} from "./schema.js";

/** `_variant` may be absent (the first applies) but, when named, must be one the block declares. */
function checkVariant(
  def: BlockDef,
  block: unknown,
  path: string,
  issues: SpecIssue[],
  opts: ValidateOptions,
): void {
  const named = own(block as object, "_variant");
  if (named === undefined || named === null || named === "") return;
  const variants = blockVariants(def);
  if (variants.length === 0) return;
  if (!variants.some((v) => v.value === named)) {
    push(
      issues,
      opts,
      `${path}._variant`,
      "unknown_variant",
      `"${clip(String(named))}" is not a variant of this block.`,
      `One of: ${variants.map((v) => v.value).join(", ")}.`,
    );
  }
}

export interface ValidateOptions {
  /** Strict mode reports keys the schema does not know about. */
  strict?: boolean;
  /** Prefix for issue paths, used when validating nested structures. */
  basePath?: string;
  /** File shown in errors. */
  file?: string;
  /** Block definitions, so a nested `blocks` field can check what it holds. */
  blocks?: Record<string, BlockDef>;
}

export type ValidationResult =
  | { ok: true; issues: readonly SpecIssue[] }
  | { ok: false; issues: readonly SpecIssue[] };

/** A schema's `pattern`, compiled once however many values it checks. */
const patterns = new Map<string, RegExp>();

function compiled(source: string): RegExp {
  let pattern = patterns.get(source);
  if (!pattern) {
    if (patterns.size >= 500) patterns.clear();
    pattern = new RegExp(source);
    patterns.set(source, pattern);
  }
  return pattern;
}

/** Tests a value against a compiled `pattern`; null says the check was stopped before it finished. */
export type PatternMatcher = (pattern: RegExp, value: string) => boolean | null;

let matcher: PatternMatcher | undefined;

/**
 * Lets a long-running host, such as the studio, put a time limit on a schema's patterns. Without
 * one a pattern is simply tested, which is what a build and the command line do.
 */
export function usePatternMatcher(next: PatternMatcher | undefined): void {
  matcher = next;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function validateFields(
  fields: Record<string, FieldDef>,
  value: unknown,
  opts: ValidateOptions = {},
): ValidationResult {
  const issues: SpecIssue[] = [];
  boundedDepth(opts.file, () => checkFields(fields, value, opts.basePath ?? "", issues, opts));
  return issues.length === 0 ? { ok: true, issues } : { ok: false, issues };
}

function checkFields(
  fields: Record<string, FieldDef>,
  value: unknown,
  base: string,
  issues: SpecIssue[],
  opts: ValidateOptions,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(
      issue(
        opts,
        base,
        "expected_object",
        "Expected an object of fields.",
        "Check the file shape.",
      ),
    );
    return;
  }

  const data = value as Record<string, unknown>;

  for (const [name, def] of Object.entries(fields)) {
    // A field its condition hides is not asked for: whatever it holds is kept, not checked.
    if (!conditionMet(def, data)) continue;
    validateField(def, own(data, name), joinPath(base, name), issues, opts);
  }

  if (opts.strict) {
    for (const key of Object.keys(data)) {
      if (key.startsWith("_")) continue; // machinery: _meta, _type, _ast
      if (!Object.hasOwn(fields, key)) {
        issues.push(
          issue(
            opts,
            joinPath(base, key),
            "unknown_field",
            `"${clip(key)}" is not defined in the schema.`,
            `Add \`${clip(key)}\` to the schema, or remove it from the content.`,
          ),
        );
      }
    }
  }
}

function validateField(
  def: FieldDef,
  value: unknown,
  path: string,
  issues: SpecIssue[],
  opts: ValidateOptions,
): void {
  // A multi-reference resolves to `[]`, so for one that is required, empty is missing.
  const missing =
    value === undefined ||
    value === null ||
    value === "" ||
    (def.type === "reference" && def.multiple === true && Array.isArray(value) && !value.length);

  if (missing) {
    if (def.required) {
      issues.push(
        issue(
          opts,
          path,
          "required",
          "This field is required but is empty.",
          // Both ways out: outside the studio, the schema is as editable as the content.
          `Give \`${path}\` a value, or drop \`required: true\` from the field in the schema.`,
        ),
      );
    }
    return;
  }

  switch (def.type) {
    case "text": {
      if (typeof value !== "string") {
        push(issues, opts, path, "expected_string", "Expected text.");
        return;
      }
      if (def.min !== undefined && value.length < def.min) {
        push(
          issues,
          opts,
          path,
          "too_short",
          `Must be at least ${def.min} characters (has ${value.length}).`,
        );
      }
      if (def.max !== undefined && value.length > def.max) {
        push(
          issues,
          opts,
          path,
          "too_long",
          `Must be at most ${def.max} characters (has ${value.length}).`,
        );
      }
      if (def.pattern) {
        const pattern = compiled(def.pattern);
        const matched = matcher ? matcher(pattern, value) : pattern.test(value);
        if (matched === null) {
          push(
            issues,
            opts,
            path,
            "pattern_timeout",
            `Could not be checked against pattern ${def.pattern} in time, so it was not accepted.`,
          );
        } else if (!matched) {
          push(
            issues,
            opts,
            path,
            "pattern_mismatch",
            `Does not match required pattern ${def.pattern}.`,
          );
        }
      }
      return;
    }

    case "richtext": {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as { html?: unknown }).html !== "string"
      ) {
        push(
          issues,
          opts,
          path,
          "expected_richtext",
          "Expected an object with an `html` string.",
          'Rich text is stored as `{ "html": "<p>…</p>" }` so any language can render it.',
        );
      }
      return;
    }

    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        push(issues, opts, path, "expected_number", "Expected a number.");
        return;
      }
      if (def.integer && !Number.isInteger(value)) {
        push(issues, opts, path, "expected_integer", "Expected a whole number.");
      }
      if (def.min !== undefined && value < def.min) {
        push(issues, opts, path, "too_small", `Must be at least ${def.min}.`);
      }
      if (def.max !== undefined && value > def.max) {
        push(issues, opts, path, "too_large", `Must be at most ${def.max}.`);
      }
      return;
    }

    case "boolean": {
      if (typeof value !== "boolean")
        push(issues, opts, path, "expected_boolean", "Expected true or false.");
      return;
    }

    case "select": {
      const allowed = selectOptions(def).map((o) => o.value);
      const values = def.multiple ? value : [value];
      if (def.multiple && !Array.isArray(value)) {
        push(issues, opts, path, "expected_array", "Expected a list of values.");
        return;
      }
      for (const v of values as unknown[]) {
        if (typeof v !== "string" || !allowed.includes(v)) {
          push(
            issues,
            opts,
            path,
            "not_an_option",
            `"${clip(String(v))}" is not one of the allowed options.`,
            `Allowed: ${allowed.join(", ")}.`,
          );
        }
      }
      return;
    }

    case "date": {
      if (typeof value !== "string" || !ISO_DATE.test(value)) {
        push(
          issues,
          opts,
          path,
          "expected_date",
          "Expected an ISO 8601 date string.",
          "Use `2026-08-12` or `2026-08-12T18:30:00Z`.",
        );
      }
      return;
    }

    case "link": {
      const link = value as { href?: unknown };
      if (
        typeof link !== "object" ||
        link === null ||
        typeof link.href !== "string" ||
        link.href === ""
      ) {
        push(issues, opts, path, "expected_link", "Expected an object with an `href` string.");
      } else if (!isSafeUrl(link.href)) {
        unsafeUrl(issues, opts, joinPath(path, "href"));
      }
      return;
    }

    case "image": {
      const img = value as { src?: unknown; alt?: unknown };
      if (
        typeof img !== "object" ||
        img === null ||
        typeof img.src !== "string" ||
        img.src === ""
      ) {
        push(issues, opts, path, "expected_image", "Expected an object with a `src` string.");
        return;
      }
      if (!isSafeUrl(img.src)) unsafeUrl(issues, opts, joinPath(path, "src"));
      if (typeof img.alt !== "string") {
        push(
          issues,
          opts,
          joinPath(path, "alt"),
          "missing_alt",
          "Image has no alt text.",
          "Describe the image for screen readers, or set `alt: decorative-allowed` on the field and use an empty string for purely decorative images.",
        );
      } else if (img.alt === "" && (def.alt ?? "required") === "required") {
        push(
          issues,
          opts,
          joinPath(path, "alt"),
          "empty_alt",
          "Alt text is empty, but this field requires it.",
          "Describe the image, or mark the field `alt: decorative-allowed` if it carries no meaning.",
        );
      }
      return;
    }

    case "file": {
      const f = value as { src?: unknown };
      if (typeof f !== "object" || f === null || typeof f.src !== "string" || f.src === "") {
        push(issues, opts, path, "expected_file", "Expected an object with a `src` string.");
      } else if (!isSafeUrl(f.src)) {
        unsafeUrl(issues, opts, joinPath(path, "src"));
      }
      return;
    }

    case "reference": {
      if (def.multiple && !Array.isArray(value)) {
        push(
          issues,
          opts,
          path,
          "expected_array",
          `Expected a list of \`${def.collection}\` entry slugs.`,
          'Write it as `["first-entry", "second-entry"]`.',
        );
        return;
      }
      const slugs: unknown[] = def.multiple ? (value as unknown[]) : [value];
      slugs.forEach((slug, index) => {
        if (typeof slug === "string" && isSafeSlug(slug)) return;
        push(
          issues,
          opts,
          def.multiple ? `${path}[${index}]` : path,
          "expected_slug",
          `Expected the slug of a \`${def.collection}\` entry, found ${shown(slug)}.`,
          "A slug is the entry's file name without its extension, e.g. `my-first-post`.",
        );
      });
      return;
    }

    case "list": {
      if (!Array.isArray(value)) {
        push(issues, opts, path, "expected_array", "Expected a list.");
        return;
      }
      if (def.min !== undefined && value.length < def.min) {
        push(
          issues,
          opts,
          path,
          "too_few",
          `Needs at least ${def.min} items (has ${value.length}).`,
        );
      }
      if (def.max !== undefined && value.length > def.max) {
        push(
          issues,
          opts,
          path,
          "too_many",
          `Allows at most ${def.max} items (has ${value.length}).`,
        );
      }
      value.forEach((item, i) => validateField(def.of, item, `${path}[${i}]`, issues, opts));
      return;
    }

    case "blocks": {
      if (!Array.isArray(value)) {
        push(issues, opts, path, "expected_blocks", "Expected a list of blocks.");
        return;
      }
      if (def.min !== undefined && value.length < def.min) {
        push(
          issues,
          opts,
          path,
          "too_few",
          `Needs at least ${def.min} blocks (has ${value.length}).`,
        );
      }
      if (def.max !== undefined && value.length > def.max) {
        push(
          issues,
          opts,
          path,
          "too_many",
          `Allows at most ${def.max} blocks (has ${value.length}).`,
        );
      }
      // The block definitions live on the schema, which a field does not carry;
      // validateRegion supplies them, and a bare validateFields call cannot.
      const blocks = opts.blocks;
      value.forEach((block, index) => {
        const at = `${path}[${index}]`;
        const type = blockType(block);
        if (typeof type !== "string") {
          push(issues, opts, at, "missing_block_type", "Block has no `_type`.");
          return;
        }
        if (!def.allow.includes(type)) {
          push(
            issues,
            opts,
            at,
            "block_not_allowed",
            `Block type "${clip(type)}" is not allowed here.`,
            `Allowed here: ${def.allow.join(", ")}.`,
          );
          return;
        }
        const nested = blocks ? (own(blocks, type) as BlockDef | undefined) : undefined;
        if (!nested) {
          if (blocks)
            push(
              issues,
              opts,
              at,
              "unknown_block",
              `Block type "${type}" is not defined in the schema.`,
            );
          return;
        }
        checkVariant(nested, block, at, issues, opts);
        checkFields(nested.fields, block, at, issues, opts);
      });
      return;
    }

    case "group": {
      checkFields(def.fields, value, path, issues, opts);
      return;
    }
  }
}

/** Validates a whole region document (the parsed contents of its JSON file). */
export function validateRegion(
  schema: CmsSchema,
  regionId: string,
  document: unknown,
  opts: ValidateOptions = {},
): ValidationResult {
  const region = own(schema.regions, regionId) as RegionDef | undefined;
  if (!region) {
    return {
      ok: false,
      issues: [
        issue(
          opts,
          clip(String(regionId)),
          "unknown_region",
          `Region "${clip(String(regionId))}" is not defined in the schema.`,
          "Add it under `regions:` in .cms/schema.yaml, or delete the content file.",
        ),
      ],
    };
  }
  return boundedDepth(opts.file, () =>
    validateRegionAgainst(schema, region, regionId, document, opts),
  );
}

function validateRegionAgainst(
  schema: CmsSchema,
  region: RegionDef,
  regionId: string,
  document: unknown,
  opts: ValidateOptions,
): ValidationResult {
  const withBlocks = { ...opts, blocks: schema.blocks };

  if (!isBlocksRegion(region)) {
    return validateFields(region.fields, document, withBlocks);
  }

  const issues: SpecIssue[] = [];
  const doc = document as { blocks?: unknown };
  const blocks = doc && typeof doc === "object" ? doc.blocks : undefined;

  if (!Array.isArray(blocks)) {
    return {
      ok: false,
      issues: [
        issue(
          opts,
          "blocks",
          "expected_blocks",
          "Expected a `blocks` array.",
          'A blocks region file looks like `{ "blocks": [ { "_type": "hero", … } ] }`.',
        ),
      ],
    };
  }

  if (region.min !== undefined && blocks.length < region.min) {
    push(
      issues,
      opts,
      "blocks",
      "too_few",
      `Needs at least ${region.min} blocks (has ${blocks.length}).`,
    );
  }
  if (region.max !== undefined && blocks.length > region.max) {
    push(
      issues,
      opts,
      "blocks",
      "too_many",
      `Allows at most ${region.max} blocks (has ${blocks.length}).`,
    );
  }

  blocks.forEach((block, i) => {
    const path = `blocks[${i}]`;
    const type = blockType(block);
    if (typeof type !== "string") {
      push(
        issues,
        opts,
        path,
        "missing_block_type",
        "Block has no `_type`.",
        'Every block names its type, e.g. `"_type": "hero"`.',
      );
      return;
    }
    if (!region.allow.includes(type)) {
      push(
        issues,
        opts,
        path,
        "block_not_allowed",
        `Block type "${clip(type)}" is not allowed in region "${regionId}".`,
        `Allowed here: ${region.allow.join(", ")}.`,
      );
      return;
    }
    const def = own(schema.blocks, type) as BlockDef | undefined;
    if (!def) {
      push(
        issues,
        opts,
        path,
        "unknown_block",
        `Block type "${type}" is not defined in the schema.`,
      );
      return;
    }
    checkVariant(def, block, path, issues, withBlocks);
    checkFields(def.fields, block, path, issues, withBlocks);
  });

  return issues.length === 0 ? { ok: true, issues } : { ok: false, issues };
}

/** One entry a document points at, which only something that can see the collection can confirm exists. */
export interface Reference {
  path: string;
  collection: string;
  slug: string;
}

/**
 * Every well-formed reference in a document, through groups, lists, and nested
 * blocks (given `blocks`), with the same paths validation reports. Fields their
 * `when` hides are skipped, as validation skips them.
 */
export function referencesIn(
  fields: Record<string, FieldDef>,
  value: unknown,
  opts: Pick<ValidateOptions, "basePath" | "blocks"> = {},
): Reference[] {
  const found: Reference[] = [];
  const walkFields = (defs: Record<string, FieldDef>, data: unknown, base: string) => {
    if (data === null || typeof data !== "object" || Array.isArray(data)) return;
    for (const [name, def] of Object.entries(defs)) {
      if (!conditionMet(def, data)) continue;
      walkField(def, own(data, name), joinPath(base, name));
    }
  };
  const walkField = (def: FieldDef, data: unknown, path: string): void => {
    switch (def.type) {
      case "reference": {
        if (def.multiple && !Array.isArray(data)) return;
        const slugs: unknown[] = def.multiple ? (data as unknown[]) : [data];
        slugs.forEach((slug, index) => {
          if (typeof slug !== "string" || !isSafeSlug(slug)) return;
          const at = def.multiple ? `${path}[${index}]` : path;
          found.push({ path: at, collection: def.collection, slug });
        });
        return;
      }
      case "group":
        walkFields(def.fields, data, path);
        return;
      case "list":
        if (Array.isArray(data))
          data.forEach((item, i) => walkField(def.of, item, `${path}[${i}]`));
        return;
      case "blocks":
        if (!Array.isArray(data)) return;
        data.forEach((block, index) => {
          const type = blockType(block);
          const nested =
            typeof type === "string" && opts.blocks
              ? (own(opts.blocks, type) as BlockDef | undefined)
              : undefined;
          if (nested) walkFields(nested.fields, block, `${path}[${index}]`);
        });
        return;
      default:
        return;
    }
  };
  boundedDepth(undefined, () => walkFields(fields, value, opts.basePath ?? ""));
  return found;
}

function blockType(block: unknown): unknown {
  return block !== null && typeof block === "object" ? own(block, "_type") : undefined;
}

function shown(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(clip(value));
  if (Array.isArray(value)) return "a list";
  return value !== null && typeof value === "object" ? "an object" : String(value);
}

function unsafeUrl(issues: SpecIssue[], opts: ValidateOptions, path: string): void {
  push(
    issues,
    opts,
    path,
    "unsafe_url",
    "This address could run script in a visitor's browser.",
    "Use a path such as `/about`, or an `https:`, `mailto:` or `tel:` address.",
  );
}

function push(
  issues: SpecIssue[],
  opts: ValidateOptions,
  path: string,
  code: string,
  message: string,
  fix?: string,
): void {
  issues.push(issue(opts, path, code, message, fix));
}

function issue(
  opts: ValidateOptions,
  path: string,
  code: string,
  message: string,
  fix?: string,
): SpecIssue {
  return new SpecIssue({ code, message, fix, path: path || undefined, file: opts.file });
}

function joinPath(base: string, key: string): string {
  const name = key.length > 80 ? clip(key) : key;
  return base ? `${base}.${name}` : name;
}
