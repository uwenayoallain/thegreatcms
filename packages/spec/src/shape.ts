/** Structural checks for the two `.cms` files: each problem says where it is and what to write instead. */

export interface Problem {
  path: string;
  message: string;
  fix?: string;
}

export const INVALID: unique symbol = Symbol("invalid");
export type Parsed<T> = T | typeof INVALID;

/** Reads one value at `at`, recording any problem rather than throwing. */
export type Parser<T> = (value: unknown, at: string, problems: Problem[]) => Parsed<T>;

export interface Property {
  parse: Parser<unknown>;
  required?: boolean;
  /** Applied when the key is absent; a fresh value each time. */
  default?: () => unknown;
  /** Shown when a required key is missing. */
  fix?: string;
  /** A key with nothing under it but comments parses as `null`; this reads that as absent. */
  nullIsAbsent?: boolean;
}

export type Shape = Record<string, Property>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function keyPath(at: string, key: string): string {
  return at ? `${at}.${key}` : key;
}

/** Assigns without ever reaching a prototype setter, so a key named `__proto__` is just a key. */
export function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function describe(value: unknown): string {
  if (value === null || value === undefined) return "nothing";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  if (typeof value === "string") return `the text ${JSON.stringify(value)}`;
  return `${typeof value === "number" ? "the number" : "the value"} ${String(value)}`;
}

export function fail(
  problems: Problem[],
  path: string,
  message: string,
  fix?: string,
): typeof INVALID {
  problems.push({ path, message, fix });
  return INVALID;
}

export function string(
  opts: { nonEmpty?: boolean; pattern?: RegExp; expected?: string; fix?: string } = {},
): Parser<string> {
  return (value, at, problems) => {
    if (typeof value !== "string") {
      const quote =
        typeof value === "number" || typeof value === "boolean"
          ? "Put it in quotes so YAML reads it as text."
          : undefined;
      return fail(problems, at, `Expected text, found ${describe(value)}.`, opts.fix ?? quote);
    }
    if (opts.nonEmpty && value === "") {
      return fail(problems, at, "Must not be empty.", opts.fix);
    }
    if (opts.pattern && !opts.pattern.test(value)) {
      return fail(
        problems,
        at,
        `${JSON.stringify(value)} is not ${opts.expected ?? "in the expected form"}.`,
        opts.fix,
      );
    }
    return value;
  };
}

export const boolean: Parser<boolean> = (value, at, problems) =>
  typeof value === "boolean"
    ? value
    : fail(
        problems,
        at,
        `Expected true or false, found ${describe(value)}.`,
        "Write `true` or `false`, without quotes.",
      );

export function number(
  opts: { integer?: boolean; min?: number; above?: number } = {},
): Parser<number> {
  return (value, at, problems) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fail(
        problems,
        at,
        `Expected a number, found ${describe(value)}.`,
        "Write a plain number, without quotes.",
      );
    }
    if (opts.integer && !Number.isInteger(value)) {
      return fail(problems, at, `Expected a whole number, found ${value}.`);
    }
    if (opts.min !== undefined && value < opts.min) {
      return fail(problems, at, `Must be at least ${opts.min}, found ${value}.`);
    }
    if (opts.above !== undefined && value <= opts.above) {
      return fail(problems, at, `Must be greater than ${opts.above}, found ${value}.`);
    }
    return value;
  };
}

/** A whole number of zero or more, as `min` bounds are. */
export const count = number({ integer: true, min: 0 });
/** A whole number of one or more, as `max` bounds are. */
export const positiveCount = number({ integer: true, above: 0 });

export function oneOf<T extends string>(values: readonly T[]): Parser<T> {
  return (value, at, problems) =>
    typeof value === "string" && (values as readonly string[]).includes(value)
      ? (value as T)
      : fail(
          problems,
          at,
          `Expected one of ${values.join(", ")}, found ${describe(value)}.`,
          `Use one of: ${values.join(", ")}.`,
        );
}

export function list<T>(
  item: Parser<T>,
  opts: { nonEmpty?: boolean; fix?: string } = {},
): Parser<T[]> {
  return (value, at, problems) => {
    if (!Array.isArray(value)) {
      return fail(problems, at, `Expected a list, found ${describe(value)}.`, opts.fix);
    }
    if (opts.nonEmpty && value.length === 0) {
      return fail(problems, at, "The list is empty.", opts.fix);
    }
    const out: T[] = [];
    let ok = true;
    value.forEach((entry, index) => {
      const parsed = item(entry, `${at}[${index}]`, problems);
      if (parsed === INVALID) ok = false;
      else out.push(parsed);
    });
    return ok ? out : INVALID;
  };
}

/** A mapping from names the author chose to values of one shape. */
export function record<T>(item: Parser<T>): Parser<Record<string, T>> {
  return (value, at, problems) => {
    if (!isRecord(value)) {
      return fail(problems, at, `Expected a mapping of names, found ${describe(value)}.`);
    }
    const out: Record<string, T> = {};
    let ok = true;
    for (const [key, entry] of Object.entries(value)) {
      const parsed = item(entry, keyPath(at, key), problems);
      if (parsed === INVALID) ok = false;
      else put(out, key, parsed);
    }
    return ok ? out : INVALID;
  };
}

/** Anything at all, kept as written: content, not schema. */
export const anything: Parser<unknown> = (value) => value;

export const mapping: Parser<Record<string, unknown>> = (value, at, problems) =>
  isRecord(value) ? value : fail(problems, at, `Expected a mapping, found ${describe(value)}.`);

/**
 * A mapping with known keys. Keys the shape does not name are dropped from the
 * result, which is how `unknownSchemaKeys` finds them afterwards.
 */
export function object(shape: Shape): Parser<Record<string, unknown>> {
  return (value, at, problems) => {
    if (!isRecord(value))
      return fail(problems, at, `Expected a mapping, found ${describe(value)}.`);
    return readShape(shape, value, at, problems);
  };
}

export function readShape(
  shape: Shape,
  raw: Record<string, unknown>,
  at: string,
  problems: Problem[],
): Parsed<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let ok = true;
  for (const [key, property] of Object.entries(shape)) {
    const path = keyPath(at, key);
    const given = Object.hasOwn(raw, key) ? raw[key] : undefined;
    if (given === undefined || (given === null && property.nullIsAbsent)) {
      if (property.default) put(out, key, property.default());
      else if (property.required) {
        ok = false;
        fail(problems, path, `\`${key}\` is required.`, property.fix ?? `Add \`${key}:\` here.`);
      }
      continue;
    }
    const parsed = property.parse(given, path, problems);
    if (parsed === INVALID) ok = false;
    else put(out, key, parsed);
  }
  return ok ? out : INVALID;
}

export const optional = (parse: Parser<unknown>): Property => ({ parse });
export const required = (parse: Parser<unknown>, fix?: string): Property => ({
  parse,
  required: true,
  fix,
});
export const withDefault = (parse: Parser<unknown>, value: () => unknown): Property => ({
  parse,
  default: value,
});
