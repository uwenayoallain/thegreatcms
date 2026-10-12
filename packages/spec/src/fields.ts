/** Field definitions — the vocabulary of `.cms/schema.yaml`. */

import { z } from "zod";

/** Show a field only while a sibling holds a value: `when: { field: style, equals: carousel }`. */
export interface FieldCondition {
  field: string;
  equals?: string | number | boolean;
  in?: string[];
}

const condition = z
  .object({
    field: z.string().min(1),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    in: z.array(z.string()).optional(),
  })
  .refine((c) => c.equals !== undefined || c.in !== undefined, {
    message: "`when` needs `equals` or `in`",
  });

const common = {
  label: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  when: condition.optional(),
};

/** Whether a conditional field applies, given the values beside it. */
export function conditionMet(def: { when?: FieldCondition }, siblings: unknown): boolean {
  const when = def.when;
  if (!when) return true;
  const value =
    siblings && typeof siblings === "object"
      ? (siblings as Record<string, unknown>)[when.field]
      : undefined;
  if (when.in) return when.in.includes(String(value ?? ""));
  return value === when.equals || String(value ?? "") === String(when.equals);
}

export const selectOption = z.union([
  z.string(),
  z.object({ value: z.string(), label: z.string().optional() }),
]);

/** Accessibility is structural here, not advisory: `alt` defaults to required, and the only way. */
const altPolicy = z.enum(["required", "decorative-allowed"]).default("required");

export type FieldDef =
  | {
      type: "text";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
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
      when?: FieldCondition;
      allow?: string[];
      default?: RichTextValue;
    }
  | {
      type: "number";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
      min?: number;
      max?: number;
      step?: number;
      integer?: boolean;
      default?: number;
    }
  | {
      type: "boolean";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
      default?: boolean;
    }
  | {
      type: "select";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
      options: Array<string | { value: string; label?: string }>;
      multiple?: boolean;
      default?: string | string[];
    }
  | {
      type: "date";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
      time?: boolean;
      default?: string;
    }
  | {
      type: "link";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
      default?: LinkValue;
    }
  | {
      type: "image";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
      alt?: "required" | "decorative-allowed";
      accept?: string[];
      default?: ImageValue;
    }
  | {
      type: "file";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
      accept?: string[];
      default?: FileValue;
    }
  | {
      type: "list";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
      of: FieldDef;
      min?: number;
      max?: number;
    }
  | {
      /**
       * A nested, reorderable list of blocks. This is what lets a managed
       * section hold real composed components — a grid of cards, a tabbed
       * panel — rather than only flat fields.
       */
      type: "blocks";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
      /** Block names, defined at the top level of the schema. */
      allow: string[];
      min?: number;
      max?: number;
      default?: Array<Record<string, unknown>>;
    }
  | {
      type: "group";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
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
  "blocks",
] as const;

/** Rich text travels as sanitized HTML so a consumer can print it with no library at all. */
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
      type: z.literal("blocks"),
      allow: z.array(z.string()).min(1),
      min: z.number().int().nonnegative().optional(),
      max: z.number().int().positive().optional(),
      default: z.array(z.record(z.unknown())).optional(),
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
