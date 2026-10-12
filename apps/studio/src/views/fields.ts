/** Renders form controls from field definitions. */

import { type BlockDef, type FieldDef, selectOptions } from "@greatcms/spec";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

/** What `html` actually returns: sync unless an interpolation is a promise. */
type Html = HtmlEscapedString | Promise<HtmlEscapedString>;
import { fieldName, MEDIA_ROOT } from "../form.js";
import { removeBlockControl } from "./block-actions.js";
import { summarize, variantField, variantLabel } from "./summary.js";
import { icon } from "./icons.js";

export type ErrorsByPath = Map<string, string>;

export interface RenderOptions {
  mediaPreviews?: Record<string, string>;
  /** Block definitions, so a nested `blocks` field can render what it holds. */
  blocks?: Record<string, BlockDef>;
  /** Keep the nested item affected by a server form action open after the round trip. */
  openNested?: string;
  /**
   * Rich text fields edited as source rather than through the visual editor.
   * An MDX body is JSX as much as it is prose, and a WYSIWYG round trip would
   * quietly delete the components in it.
   */
  plain?: ReadonlySet<string>;
  /** The content's language (BCP 47), so spellcheck and text direction follow the site, not the studio. */
  lang?: string;
}

export function renderFields(
  fields: Record<string, FieldDef>,
  values: Record<string, unknown>,
  errors: ErrorsByPath,
  basePath: Array<string | number> = [],
  render: RenderOptions = {},
): Html[] {
  return Object.entries(fields).map(([name, def]) =>
    renderField(def, [...basePath, name], values?.[name], errors, render),
  );
}

function renderField(
  def: FieldDef,
  path: Array<string | number>,
  value: unknown,
  errors: ErrorsByPath,
  render: RenderOptions = {},
): Html {
  const control = renderControl(def, path, value, errors, render);
  if (!def.when) return control;
  // Without JavaScript the field simply shows; the schema's condition is kept at validation.
  return html`<div
    class="when"
    data-when-of="${idFor([...path.slice(0, -1), def.when.field])}"
    data-when="${JSON.stringify(def.when.in ?? [String(def.when.equals)])}"
  >
    ${control}
  </div>`;
}

function renderControl(
  def: FieldDef,
  path: Array<string | number>,
  value: unknown,
  errors: ErrorsByPath,
  render: RenderOptions = {},
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
    lang: render.lang,
    // The browser lays each value out in its own direction, so Arabic or Hebrew content edits right to left.
    dir: "auto",
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

    case "richtext": {
      const plain = render.plain?.has(String(path.at(-1)));
      return shell(html`
        <textarea ${shared} rows="14" ${raw(plain ? 'class="source"' : "data-richtext")}>
${asText(readRichText(value))}</textarea>
        <span class="hint"
          >${
            plain
              ? "MDX source. Edited as written, because the components in it are not HTML."
              : "HTML. Stored as written, so any language can render it without a library."
          }</span
        >
      `);
    }

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
          ${
            image.src
              ? html`<p class="preview-thumb">
                  <img
                    src="${render.mediaPreviews?.[image.src] ?? asText(image.src)}"
                    alt=""
                    width="${image.width ?? 160}"
                    height="${image.height ?? 100}"
                    loading="lazy"
                  />
                  <span class="hint">${asText(image.src)}</span>
                </p>`
              : ""
          }

          <div class="field upload">
            <label for="${id}-file">${image.src ? "Replace the image" : "Upload an image"}</label>
            <input
              type="file"
              id="${id}-file"
              name="${fieldName(path, MEDIA_ROOT)}"
              accept="${(def.accept ?? ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]).join(",")}"
              aria-describedby="${id}-file-hint"
            />
            <span class="hint" id="${id}-file-hint">
              Committed with your content in the same change. Width and height are read from the
              file, so pages do not jump while it loads.
            </span>
          </div>

          <div class="field">
            <label for="${id}-src">Or use an image URL</label>
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
          ${rows.map((item, index) =>
            renderField(
              // A row is named for its position, which reads as "0" unless it is given a label.
              {
                ...def.of,
                label: def.of.label ?? (index < items.length ? `Item ${index + 1}` : "New item"),
              },
              [...path, index],
              item,
              errors,
              render,
            ),
          )}
          <span class="hint"
            >Fill in the empty row to add an item, or clear one to remove it. Another empty row
            appears each time the page reloads.</span
          >
        </fieldset>
      `;
    }

    case "blocks": {
      const items = (Array.isArray(value) ? value : []) as Array<Record<string, unknown>>;
      const actionPath = path.join(".");
      const onlyType = def.allow.length === 1 ? def.allow[0] : undefined;
      const itemLabel = onlyType
        ? (render.blocks?.[onlyType]?.label ?? humanize(onlyType))
        : "Item";

      return html`
        <fieldset class="field blocks-field">
          <legend>${label}</legend>
          ${def.description ? html`<span class="hint">${def.description}</span>` : ""}
          ${
            items.length > 2
              ? html`
                  <nav class="outline" aria-label="${label}: every item">
                    <p class="stamp">${items.length} ${label.toLowerCase()}</p>
                    <ol>
                      ${items.map((item, index) => {
                        const type = typeof item._type === "string" ? item._type : "";
                        const definition = type ? render.blocks?.[type] : undefined;
                        return html`<li>
                          <a href="#${idFor([...path, index])}"
                            >${onlyType ? `${itemLabel} ${index + 1}` : (definition?.label ?? humanize(type || "item"))}
                            <span>${nestedBlockSummary(item, definition)}</span></a
                          >
                        </li>`;
                      })}
                    </ol>
                    <a class="outline-add" href="#${id}-add-block">${icon("plus")} Add one</a>
                  </nav>
                `
              : ""
          }
          ${items.map((item, index) => {
            const type = typeof item._type === "string" ? item._type : "";
            const definition = type ? render.blocks?.[type] : undefined;
            const typePath = [...path, index, "_type"];
            const typeId = idFor(typePath);
            const itemPath = [...path, index];
            const itemName = onlyType
              ? `${itemLabel} ${index + 1}`
              : `${definition?.label ?? humanize(type || "item")} ${index + 1}`;
            const hasError = [...errors.keys()].some((errorPath) =>
              errorPath.startsWith(dotted(itemPath)),
            );
            const actionWithin =
              render.openNested === itemPath.join(".") ||
              render.openNested?.startsWith(`${itemPath.join(".")}.`);

            return html`
              <section
                class="block nested block-collapsible nested-collapsible"
                id="${idFor(itemPath)}"
              >
                <details ${actionWithin || hasError ? "open" : ""}>
                  <summary>
                    <h3>${itemName}</h3>
                    <span>${nestedBlockSummary(item, definition)}</span>
                  </summary>
                  <div class="block-fields">
                    ${
                      onlyType
                        ? html`<input
                            type="hidden"
                            name="${fieldName(typePath)}"
                            value="${type}"
                          />`
                        : html`<div class="field">
                            <label for="${typeId}">Type</label>
                            <select id="${typeId}" name="${fieldName(typePath)}">
                              ${def.allow.map(
                                (allowed) => html`
                                  <option value="${allowed}" ${allowed === type ? "selected" : ""}>
                                    ${render.blocks?.[allowed]?.label ?? allowed}
                                  </option>
                                `,
                              )}
                            </select>
                          </div>`
                    }
                    ${variantField(
                      item,
                      definition,
                      fieldName([...itemPath, "_variant"]),
                      idFor([...itemPath, "_variant"]),
                    )}
                    ${
                      definition
                        ? renderFields(definition.fields, item, errors, itemPath, render)
                        : html`<span class="hint">
                            This block type is no longer in the schema.
                          </span>`
                    }
                  </div>
                </details>
                <div class="tools" aria-label="Reorder or remove ${itemName}">
                  <button
                    type="submit"
                    name="action"
                    value="nested:up:${actionPath}:${index}"
                    aria-label="Move ${itemName} up"
                    title="Move up"
                    formnovalidate
                    ${index === 0 ? "disabled" : ""}
                  >
                    ${icon("up")}
                  </button>
                  <button
                    type="submit"
                    name="action"
                    value="nested:down:${actionPath}:${index}"
                    aria-label="Move ${itemName} down"
                    title="Move down"
                    formnovalidate
                    ${index === items.length - 1 ? "disabled" : ""}
                  >
                    ${icon("down")}
                  </button>
                  ${removeBlockControl(itemName, `nested:remove:${actionPath}:${index}`)}
                </div>
              </section>
            `;
          })}
          ${
            items.length === 0
              ? html`<p class="nested-empty">No ${label.toLowerCase()} yet.</p>`
              : ""
          }
          <div class="add-block nested-add" id="${id}-add-block">
            ${
              onlyType
                ? html`<input
                    type="hidden"
                    name="${fieldName(path, "nestedAdd")}"
                    value="${onlyType}"
                  />`
                : html`<div class="field">
                    <label for="${id}-add">Add an item</label>
                    <select id="${id}-add" name="${fieldName(path, "nestedAdd")}">
                      ${def.allow.map(
                        (allowed) => html`
                          <option value="${allowed}">
                            ${render.blocks?.[allowed]?.label ?? allowed}
                          </option>
                        `,
                      )}
                    </select>
                  </div>`
            }
            <button
              type="submit"
              class="secondary"
              name="action"
              value="nested:add:${actionPath}"
              formnovalidate
            >
              Add ${onlyType ? itemLabel.toLowerCase() : "item"}
            </button>
          </div>
        </fieldset>
      `;
    }

    case "group":
      return html`
        <fieldset class="field">
          <legend>${label}</legend>
          ${def.description ? html`<span class="hint">${def.description}</span>` : ""}
          ${renderFields(def.fields, (value ?? {}) as Record<string, unknown>, errors, path, render)}
        </fieldset>
      `;
  }
}

/** True when any field, at any depth, is rich text the visual editor should mount on. */
export function hasRichText(
  fields: Record<string, FieldDef>,
  plain: ReadonlySet<string> = new Set(),
): boolean {
  return Object.entries(fields).some(([name, def]) => {
    if (def.type === "richtext") return !plain.has(name);
    if (def.type === "group") return hasRichText(def.fields, plain);
    if (def.type === "list") return hasRichText({ item: def.of }, plain);
    // A nested blocks field may hold rich text; its types are resolved elsewhere,
    // so assume it can and let the editor mount.
    if (def.type === "blocks") return true;
    return false;
  });
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

/** Renders an attribute list. */
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

export function idFor(path: Array<string | number>): string {
  return `f-${path.join("-")}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** A richtext value is an object; a collection body may arrive as a string. */
function readRichText(value: unknown): string {
  if (typeof value === "string") return value;
  return (value as { html?: string })?.html ?? "";
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function nestedBlockSummary(item: Record<string, unknown>, definition?: BlockDef): string {
  const variant = variantLabel(item, definition);
  return `${summarize(item, definition, "Empty item")}${variant ? ` · ${variant}` : ""}`;
}

function humanize(name: string): string {
  const spaced = name.replace(/[-_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
