/** Field definitions: the vocabulary of `.cms/schema.yaml`. */

import {
  type Parser,
  type Problem,
  type Shape,
  INVALID,
  anything,
  boolean,
  count,
  describe,
  fail,
  isRecord,
  keyPath,
  list,
  mapping,
  number,
  object,
  oneOf,
  optional,
  own,
  positiveCount,
  readShape,
  record,
  required,
  string,
  withDefault,
} from "./shape.js";

/** Show a field only while a sibling holds a value: `when: { field: style, equals: carousel }`. */
export interface FieldCondition {
  field: string;
  equals?: string | number | boolean;
  in?: string[];
}

const conditionShape = object({
  field: required(string({ nonEmpty: true }), "Name the sibling field, e.g. `field: style`."),
  equals: optional((value, at, problems) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? value
      : fail(problems, at, `Expected text, a number or true/false, found ${describe(value)}.`),
  ),
  in: optional(list(string())),
});

const condition: Parser<FieldCondition> = (value, at, problems) => {
  const parsed = conditionShape(value, at, problems);
  if (parsed === INVALID) return INVALID;
  if (parsed.equals === undefined && parsed.in === undefined) {
    return fail(
      problems,
      at,
      "`when` needs `equals` or `in`.",
      "Write e.g. `when: { field: style, equals: carousel }` or `when: { field: style, in: [a, b] }`.",
    );
  }
  return parsed as unknown as FieldCondition;
};

const common: Shape = {
  label: optional(string()),
  description: optional(string()),
  required: optional(boolean),
  when: optional(condition),
};

/** Whether a conditional field applies, given the values beside it. */
export function conditionMet(def: { when?: FieldCondition }, siblings: unknown): boolean {
  const when = def.when;
  if (!when) return true;
  const value = siblings && typeof siblings === "object" ? own(siblings, when.field) : undefined;
  if (when.in) return when.in.includes(String(value ?? ""));
  return value === when.equals || String(value ?? "") === String(when.equals);
}

export type SelectOption = string | { value: string; label?: string };

const optionShape = object({
  value: required(string(), "Give the option a `value`, e.g. `{ value: navy, label: Navy }`."),
  label: optional(string()),
});

/** `a`, or `{ value: a, label: A }`. */
export const selectOption: Parser<SelectOption> = (value, at, problems) =>
  typeof value === "string"
    ? value
    : isRecord(value)
      ? (optionShape(value, at, problems) as SelectOption | typeof INVALID)
      : fail(
          problems,
          at,
          `Expected an option, found ${describe(value)}.`,
          "Write an option as `a` or as `{ value: a, label: A }`.",
        );

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
      options: SelectOption[];
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
      /** Entries of a collection, by slug. */
      type: "reference";
      label?: string;
      description?: string;
      required?: boolean;
      when?: FieldCondition;
      collection: string;
      multiple?: boolean;
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
       * section hold real composed components, a grid of cards, a tabbed
       * panel, rather than only flat fields.
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
  "reference",
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

const richTextValue = object({ html: required(string()), _ast: optional(anything) });
const linkValue = object({
  href: required(string()),
  label: optional(string()),
  external: optional(boolean),
});
const imageValue = object({
  src: required(string()),
  alt: required(string(), 'Give the default image `alt` text, or `alt: ""` if it is decorative.'),
  width: optional(number()),
  height: optional(number()),
});
const fileValue = object({
  src: required(string()),
  name: optional(string()),
  size: optional(number()),
});
const strings = list(string());

/** The keys each field type takes beyond `label`, `description`, `required` and `when`. */
const FIELD_SHAPES: Record<FieldType, Shape> = {
  text: {
    min: optional(count),
    max: optional(positiveCount),
    pattern: optional(regexSource),
    multiline: optional(boolean),
    default: optional(string()),
  },
  richtext: { allow: optional(strings), default: optional(richTextValue) },
  number: {
    min: optional(number()),
    max: optional(number()),
    step: optional(number({ above: 0 })),
    integer: optional(boolean),
    default: optional(number()),
  },
  boolean: { default: optional(boolean) },
  select: {
    options: required(
      list(selectOption, {
        nonEmpty: true,
        fix: "List at least one option, e.g. `[draft, live]`.",
      }),
      "List the choices, e.g. `options: [draft, live]`.",
    ),
    multiple: optional(boolean),
    default: optional((value, at, problems) =>
      Array.isArray(value) ? strings(value, at, problems) : string()(value, at, problems),
    ),
  },
  date: { time: optional(boolean), default: optional(string()) },
  link: { default: optional(linkValue) },
  image: {
    // Accessibility is structural here, not advisory: `alt` defaults to required.
    alt: withDefault(oneOf(["required", "decorative-allowed"]), () => "required"),
    accept: optional(strings),
    default: optional(imageValue),
  },
  file: { accept: optional(strings), default: optional(fileValue) },
  reference: {
    collection: required(
      string({ nonEmpty: true }),
      "Name the collection its entries come from, e.g. `collection: blog`.",
    ),
    multiple: optional(boolean),
  },
  list: {
    of: required(
      (value, at, problems) => parseFieldDef(value, at, problems),
      "Say what each item is, e.g. `of: { type: text }`.",
    ),
    min: optional(count),
    max: optional(positiveCount),
  },
  blocks: {
    allow: required(
      list(string(), {
        nonEmpty: true,
        fix: "Name at least one block defined under `blocks:`.",
      }),
      "Name the blocks it may hold, e.g. `allow: [hero, text]`.",
    ),
    min: optional(count),
    max: optional(positiveCount),
    default: optional(list(mapping)),
  },
  group: {
    fields: required(
      (value, at, problems) => parseFields(value, at, problems),
      "Give the group its own `fields:`.",
    ),
  },
};

function regexSource(value: unknown, at: string, problems: Problem[]): string | typeof INVALID {
  const source = string()(value, at, problems);
  if (source === INVALID) return INVALID;
  try {
    void new RegExp(source);
    return source;
  } catch (err) {
    return fail(
      problems,
      at,
      `Not a valid regular expression: ${(err as Error).message}.`,
      "Fix the expression; in YAML, single-quote it so backslashes survive.",
    );
  }
}

const TYPE_HINT = `Use one of: ${FIELD_TYPES.join(", ")}.`;

/** One field definition, checked against the keys its `type` takes. */
export const parseFieldDef: Parser<FieldDef> = (value, at, problems) => {
  if (!isRecord(value)) {
    return fail(
      problems,
      at,
      `Expected a field definition, found ${describe(value)}.`,
      "Write a field as a mapping with a `type`, e.g. `{ type: text }`.",
    );
  }
  const type = value.type;
  if (type === undefined) {
    return fail(problems, keyPath(at, "type"), "Field has no `type`.", TYPE_HINT);
  }
  if (typeof type !== "string" || !Object.hasOwn(FIELD_SHAPES, type)) {
    return fail(
      problems,
      keyPath(at, "type"),
      `${describe(type).replace(/^the text /, "")} is not a field type.`,
      TYPE_HINT,
    );
  }
  const parsed = readShape(
    { type: required(anything), ...common, ...FIELD_SHAPES[type as FieldType] },
    value,
    at,
    problems,
  );
  return parsed === INVALID ? INVALID : (parsed as FieldDef);
};

export const parseFields: Parser<Record<string, FieldDef>> = record(parseFieldDef);

/** Normalizes `options` to the object form so consumers handle one shape. */
export function selectOptions(field: Extract<FieldDef, { type: "select" }>): Array<{
  value: string;
  label: string;
}> {
  return field.options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value },
  );
}
