/**
 * Field definitions — the vocabulary of `.cms/schema.yaml`.
 *
 * These describe *shape*, never presentation. A consumer in any language reads
 * the resulting JSON without needing this package; the definitions exist so the
 * studio can generate an editor and so content can be validated before commit.
 */

import { z } from "zod";

const common = {
  label: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
};

const selectOption = z.union([
  z.string(),
  z.object({ value: z.string(), label: z.string().optional() }),
]);

/**
 * Accessibility is structural here, not advisory: `alt` defaults to required,
 * and the only way to omit it is to explicitly mark an image decorative, which
 * is a deliberate authoring act rather than an oversight.
 */
const altPolicy = z.enum(["required", "decorative-allowed"]).default("required");

export type FieldDef =
  | {
      type: "text";
      label?: string;
      description?: string;
      required?: boolean;
      min?: number;
      max?: number;
      pattern?: string;
      multiline?: boolean;
      default?: string;
    }
  | {
      type: "richtext";
      label?: string;
      description?: string;
      required?: boolean;
      allow?: string[];
      default?: RichTextValue;
    }
  | {
      type: "number";
      label?: string;
      description?: string;
      required?: boolean;
      min?: number;
      max?: number;
      step?: number;
      integer?: boolean;
      default?: number;
    }
  | { type: "boolean"; label?: string; description?: string; required?: boolean; default?: boolean }
  | {
      type: "select";
      label?: string;
      description?: string;
      required?: boolean;
      options: Array<string | { value: string; label?: string }>;
      multiple?: boolean;
      default?: string | string[];
    }
  | {
      type: "date";
      label?: string;
      description?: string;
      required?: boolean;
      time?: boolean;
      default?: string;
    }
  | { type: "link"; label?: string; description?: string; required?: boolean; default?: LinkValue }
  | {
      type: "image";
      label?: string;
      description?: string;
      required?: boolean;
      alt?: "required" | "decorative-allowed";
      accept?: string[];
      default?: ImageValue;
    }
  | {
      type: "file";
      label?: string;
      description?: string;
      required?: boolean;
      accept?: string[];
      default?: FileValue;
    }
  | {
      type: "list";
      label?: string;
      description?: string;
      required?: boolean;
      of: FieldDef;
      min?: number;
      max?: number;
    }
  | {
      type: "group";
      label?: string;
      description?: string;
      required?: boolean;
      fields: Record<string, FieldDef>;
    };

export type FieldType = FieldDef["type"];

export const FIELD_TYPES: readonly FieldType[] = [
  "text",
  "richtext",
  "number",
  "boolean",
  "select",
  "date",
  "link",
  "image",
  "file",
  "list",
  "group",
] as const;

/**
 * Rich text travels as sanitized HTML so a consumer can print it with no
 * library at all. `_ast` carries the editor's structured document for lossless
 * round-tripping and is safe to ignore — the underscore marks it as machinery.
 */
export interface RichTextValue {
  html: string;
  _ast?: unknown;
}

export interface LinkValue {
  href: string;
  label?: string;
  /** Set by the studio when the href leaves the site; consumers may use it for rel/target. */
  external?: boolean;
}

export interface ImageValue {
  src: string;
  /** Empty string is valid *only* for images declared decorative. */
  alt: string;
  width?: number;
  height?: number;
}

export interface FileValue {
  src: string;
  name?: string;
  size?: number;
}

export const FieldDefSchema: z.ZodType<FieldDef> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      ...common,
      type: z.literal("text"),
      min: z.number().int().nonnegative().optional(),
      max: z.number().int().positive().optional(),
      pattern: z.string().optional(),
      multiline: z.boolean().optional(),
      default: z.string().optional(),
    }),
    z.object({
      ...common,
      type: z.literal("richtext"),
      allow: z.array(z.string()).optional(),
      default: z.object({ html: z.string(), _ast: z.unknown().optional() }).optional(),
    }),
    z.object({
      ...common,
      type: z.literal("number"),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().positive().optional(),
      integer: z.boolean().optional(),
      default: z.number().optional(),
    }),
    z.object({ ...common, type: z.literal("boolean"), default: z.boolean().optional() }),
    z.object({
      ...common,
      type: z.literal("select"),
      options: z.array(selectOption).min(1),
      multiple: z.boolean().optional(),
      default: z.union([z.string(), z.array(z.string())]).optional(),
    }),
    z.object({
      ...common,
      type: z.literal("date"),
      time: z.boolean().optional(),
      default: z.string().optional(),
    }),
    z.object({
      ...common,
      type: z.literal("link"),
      default: z
        .object({
          href: z.string(),
          label: z.string().optional(),
          external: z.boolean().optional(),
        })
        .optional(),
    }),
    z.object({
      ...common,
      type: z.literal("image"),
      alt: altPolicy,
      accept: z.array(z.string()).optional(),
      default: z
        .object({
          src: z.string(),
          alt: z.string(),
          width: z.number().optional(),
          height: z.number().optional(),
        })
        .optional(),
    }),
    z.object({
      ...common,
      type: z.literal("file"),
      accept: z.array(z.string()).optional(),
      default: z
        .object({
          src: z.string(),
          name: z.string().optional(),
          size: z.number().optional(),
        })
        .optional(),
    }),
    z.object({
      ...common,
      type: z.literal("list"),
      of: FieldDefSchema,
      min: z.number().int().nonnegative().optional(),
      max: z.number().int().positive().optional(),
    }),
    z.object({
      ...common,
      type: z.literal("group"),
      fields: z.record(FieldDefSchema),
    }),
  ]),
) as z.ZodType<FieldDef>;

/** Normalizes `options` to the object form so consumers handle one shape. */
export function selectOptions(field: Extract<FieldDef, { type: "select" }>): Array<{
  value: string;
  label: string;
}> {
  return field.options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value },
  );
}
