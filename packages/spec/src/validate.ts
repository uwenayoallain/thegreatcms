/** Content validation. */

import { SpecIssue } from "./errors.js";
import { type FieldDef, selectOptions } from "./fields.js";
import { type BlockDef, type CmsSchema, type RegionDef, isBlocksRegion } from "./schema.js";

export interface ValidateOptions {
  /** Strict mode reports keys the schema does not know about. */
  strict?: boolean;
  /** Prefix for issue paths, used when validating nested structures. */
  basePath?: string;
  /** File shown in errors. */
  file?: string;
}

export type ValidationResult =
  | { ok: true; issues: readonly SpecIssue[] }
  | { ok: false; issues: readonly SpecIssue[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function validateFields(
  fields: Record<string, FieldDef>,
  value: unknown,
  opts: ValidateOptions = {},
): ValidationResult {
  const issues: SpecIssue[] = [];
  const base = opts.basePath ?? "";

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
    return { ok: false, issues };
  }

  const data = value as Record<string, unknown>;

  for (const [name, def] of Object.entries(fields)) {
    validateField(def, data[name], joinPath(base, name), issues, opts);
  }

  if (opts.strict) {
    for (const key of Object.keys(data)) {
      if (key.startsWith("_")) continue; // machinery: _meta, _type, _ast
      if (!(key in fields)) {
        issues.push(
          issue(
            opts,
            joinPath(base, key),
            "unknown_field",
            `"${key}" is not defined in the schema.`,
            `Add \`${key}\` to the schema, or remove it from the content.`,
          ),
        );
      }
    }
  }

  return issues.length === 0 ? { ok: true, issues } : { ok: false, issues };
}

function validateField(
  def: FieldDef,
  value: unknown,
  path: string,
  issues: SpecIssue[],
  opts: ValidateOptions,
): void {
  const missing = value === undefined || value === null || value === "";

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
      if (def.pattern && !new RegExp(def.pattern).test(value)) {
        push(
          issues,
          opts,
          path,
          "pattern_mismatch",
          `Does not match required pattern ${def.pattern}.`,
        );
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
            `"${String(v)}" is not one of the allowed options.`,
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
      }
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

    case "group": {
      const result = validateFields(def.fields, value, { ...opts, basePath: path });
      issues.push(...result.issues);
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
  const region = schema.regions[regionId];
  if (!region) {
    return {
      ok: false,
      issues: [
        issue(
          opts,
          regionId,
          "unknown_region",
          `Region "${regionId}" is not defined in the schema.`,
          "Add it under `regions:` in .cms/schema.yaml, or delete the content file.",
        ),
      ],
    };
  }
  return validateRegionAgainst(schema, region, regionId, document, opts);
}

function validateRegionAgainst(
  schema: CmsSchema,
  region: RegionDef,
  regionId: string,
  document: unknown,
  opts: ValidateOptions,
): ValidationResult {
  if (!isBlocksRegion(region)) {
    return validateFields(region.fields, document, opts);
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
    const type = (block as { _type?: unknown })?._type;
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
        `Block type "${type}" is not allowed in region "${regionId}".`,
        `Allowed here: ${region.allow.join(", ")}.`,
      );
      return;
    }
    const def: BlockDef | undefined = schema.blocks[type];
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
    issues.push(...validateFields(def.fields, block, { ...opts, basePath: path }).issues);
  });

  return issues.length === 0 ? { ok: true, issues } : { ok: false, issues };
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
  return base ? `${base}.${key}` : key;
}
