/**
 * Renders form controls from field definitions.
 *
 * Every control is a native HTML element with a real `<label for>`, so the
 * editor is keyboard-operable and screen-reader-legible without a single line
 * of ARIA plumbing. Validation errors are attached with `aria-describedby` and
 * `aria-invalid` rather than colour alone.
 */

import { type FieldDef, selectOptions } from "@greatcms/spec";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

/** What `html` actually returns: sync unless an interpolation is a promise. */
type Html = HtmlEscapedString | Promise<HtmlEscapedString>;
import { fieldName } from "../form.js";

export type ErrorsByPath = Map<string, string>;

export function renderFields(
  fields: Record<string, FieldDef>,
  values: Record<string, unknown>,
  errors: ErrorsByPath,
  basePath: Array<string | number> = [],
): Html[] {
  return Object.entries(fields).map(([name, def]) =>
    renderField(def, [...basePath, name], values?.[name], errors),
  );
}

function renderField(
  def: FieldDef,
  path: Array<string | number>,
  value: unknown,
  errors: ErrorsByPath,
): Html {
  const name = fieldName(path);
  const id = idFor(path);
  const label = def.label ?? humanize(String(path.at(-1)));
  const error = errors.get(dotted(path));
  const describedBy = [def.description ? `${id}-hint` : "", error ? `${id}-error` : ""]
    .filter(Boolean)
    .join(" ");

  const shell = (control: Html, labelled = true) => html`
    <div class="field">
      ${
        labelled
          ? html`<label for="${id}">
              ${label}${
                def.required
                  ? html` <span aria-hidden="true">*</span
                      ><span class="visually-hidden"> (required)</span>`
                  : ""
              }
            </label>`
          : ""
      }
      ${def.description ? html`<span class="hint" id="${id}-hint">${def.description}</span>` : ""}
      ${control} ${error ? html`<p class="error-text" id="${id}-error">${error}</p>` : ""}
    </div>
  `;

  const shared = attrs({
    id,
    name,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": error ? "true" : undefined,
    required: def.required || undefined,
  });

  switch (def.type) {
    case "text":
      return def.multiline
        ? shell(html`<textarea ${shared} rows="5">${asText(value)}</textarea>`)
        : shell(
            html`<input
              type="text"
              ${shared}
              value="${asText(value)}"
              ${attrs({
                maxlength: def.max,
              })}
            />`,
          );

    case "richtext":
      return shell(html`
        <textarea ${shared} rows="10">${asText((value as { html?: string })?.html)}</textarea>
        <span class="hint"
          >HTML. Stored as written, so any language can render it without a library.</span
        >
      `);

    case "number":
      return shell(
        html`<input
          type="number"
          ${shared}
          value="${asText(value)}"
          ${attrs({
            min: def.min,
            max: def.max,
            step: def.integer ? 1 : def.step,
          })}
        />`,
      );

    case "boolean":
      return html`
        <div class="field checkbox">
          <input
            type="checkbox"
            id="${id}"
            name="${name}"
            value="yes"
            ${attrs({
              checked: Boolean(value),
            })}
          />
          <label for="${id}">${label}</label>
        </div>
      `;

    case "select": {
      const options = selectOptions(def);
      const selected = new Set(Array.isArray(value) ? value.map(String) : [String(value ?? "")]);
      return shell(html`
        <select ${shared} ${raw(def.multiple ? "multiple" : "")}>
          ${def.required ? "" : html`<option value="">— none —</option>`}
          ${options.map(
            (option) => html`
              <option value="${option.value}" ${attrs({ selected: selected.has(option.value) })}>
                ${option.label}
              </option>
            `,
          )}
        </select>
      `);
    }

    case "date":
      return shell(html`<input type="date" ${shared} value="${asText(value).slice(0, 10)}" />`);

    case "link": {
      const link = (value ?? {}) as { href?: string; label?: string };
      return html`
        <fieldset class="field">
          <legend>${label}</legend>
          <div class="row">
            <div>
              <label for="${id}-href">URL</label>
              <input
                type="text"
                id="${id}-href"
                name="${name}[href]"
                value="${asText(link.href)}"
                inputmode="url"
                ${attrs({ "aria-invalid": error ? "true" : undefined })}
              />
            </div>
            <div>
              <label for="${id}-label">Link text</label>
              <input
                type="text"
                id="${id}-label"
                name="${name}[label]"
                value="${asText(link.label)}"
              />
            </div>
          </div>
          ${error ? html`<p class="error-text">${error}</p>` : ""}
        </fieldset>
      `;
    }

    case "image": {
      const image = (value ?? {}) as {
        src?: string;
        alt?: string;
        width?: number;
        height?: number;
      };
      const altError = errors.get(dotted([...path, "alt"]));
      const decorative = def.alt === "decorative-allowed";
      return html`
        <fieldset class="field">
          <legend>${label}</legend>
          <div class="field">
            <label for="${id}-src">Image URL</label>
            <input type="text" id="${id}-src" name="${name}[src]" value="${asText(image.src)}" />
          </div>
          <div class="field">
            <label for="${id}-alt">
              Alt text${decorative ? "" : html` <span aria-hidden="true">*</span>`}
            </label>
            <input
              type="text"
              id="${id}-alt"
              name="${name}[alt]"
              value="${asText(image.alt)}"
              aria-describedby="${id}-alt-hint"
              ${attrs({ "aria-invalid": altError ? "true" : undefined })}
            />
            <span class="hint" id="${id}-alt-hint">
              ${
                decorative
                  ? "Describe the image, or leave empty if it is purely decorative."
                  : "Describe what the image shows, for people who cannot see it."
              }
            </span>
            ${altError ? html`<p class="error-text">${altError}</p>` : ""}
          </div>
          <div class="row">
            <div>
              <label for="${id}-width">Width</label>
              <input
                type="number"
                id="${id}-width"
                name="${name}[width]"
                value="${asText(image.width)}"
                min="1"
              />
            </div>
            <div>
              <label for="${id}-height">Height</label>
              <input
                type="number"
                id="${id}-height"
                name="${name}[height]"
                value="${asText(image.height)}"
                min="1"
              />
            </div>
          </div>
          <span class="hint"
            >Width and height are optional, but they stop the page jumping while the image
            loads.</span
          >
        </fieldset>
      `;
    }

    case "file": {
      const file = (value ?? {}) as { src?: string };
      return shell(html`<input type="text" ${shared} value="${asText(file.src)}" />`);
    }

    case "list": {
      const items = Array.isArray(value) ? value : [];
      // One spare row so a list can always be extended without JavaScript.
      const rows = [...items, undefined];
      return html`
        <fieldset class="field">
          <legend>${label}</legend>
          ${def.description ? html`<span class="hint">${def.description}</span>` : ""}
          ${rows.map((item, index) => renderField(def.of, [...path, index], item, errors))}
          <span class="hint">Leave a row empty to drop it. Save to add another.</span>
        </fieldset>
      `;
    }

    case "group":
      return html`
        <fieldset class="field">
          <legend>${label}</legend>
          ${def.description ? html`<span class="hint">${def.description}</span>` : ""}
          ${renderFields(def.fields, (value ?? {}) as Record<string, unknown>, errors, path)}
        </fieldset>
      `;
  }
}

/** Maps validation issue paths (`seo.title`, `tags[0]`) onto control ids. */
export function errorsByPath(
  issues: ReadonlyArray<{ path?: string; message: string }>,
): ErrorsByPath {
  const map: ErrorsByPath = new Map();
  for (const issue of issues) {
    if (!issue.path) continue;
    if (!map.has(issue.path)) map.set(issue.path, issue.message);
  }
  return map;
}

/**
 * Renders an attribute list. Values that are undefined, null, or false are
 * dropped entirely rather than rendered as "undefined" — an `aria-invalid`
 * attribute present with the wrong value is worse than an absent one.
 */
function attrs(pairs: Record<string, string | number | boolean | undefined>) {
  const rendered = Object.entries(pairs)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => (value === true ? key : `${key}="${escapeAttribute(String(value))}"`))
    .join(" ");
  return raw(rendered);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function dotted(path: Array<string | number>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc ? `${acc}.${segment}` : String(segment);
  }, "");
}

function idFor(path: Array<string | number>): string {
  return `f-${path.join("-")}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function humanize(name: string): string {
  const spaced = name.replace(/[-_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
