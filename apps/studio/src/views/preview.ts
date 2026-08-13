/**
 * Live preview of unsaved content.
 *
 * The studio cannot render your site — it never executes anything from a
 * managed repository — so this does not pretend to. It renders the *content*:
 * the fields you are editing, in the structure the schema describes, updating
 * as you type and before anything is committed.
 *
 * That makes it honest about what it is. For pixel-accurate output there are
 * two other paths, both of which build the real site: a draft branch through
 * your CI, or `greatcms preview` against your own dev server.
 */

import { type FieldDef, isBlocksRegion, selectOptions, type RegionDef } from "@greatcms/spec";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface PreviewOptions {
  title: string;
  fields?: Record<string, FieldDef>;
  region?: RegionDef;
  blocks?: Record<string, { label?: string; fields: Record<string, FieldDef> }>;
  document: Record<string, unknown>;
}

/**
 * A standalone document, served into a sandboxed iframe. Inline styles because
 * it must render with no network access of any kind.
 */
export function previewDocument(options: PreviewOptions): string {
  const body =
    options.region && isBlocksRegion(options.region)
      ? renderBlocks(options.region.allow, options.blocks ?? {}, options.document)
      : renderFields(options.fields ?? {}, options.document);

  return `<!doctype html>${html`
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Preview of ${options.title}</title>
        <style>
          ${raw(STYLES)}
        </style>
      </head>
      <body>
        <main>${body}</main>
      </body>
    </html>
  `}`;
}

function renderFields(fields: Record<string, FieldDef>, document: Record<string, unknown>): Html {
  const entries = Object.entries(fields);
  if (entries.length === 0) return html`<p class="empty">Nothing to preview yet.</p>`;

  return html`${entries.map(([name, def]) => renderField(def, name, document[name]))}`;
}

function renderBlocks(
  allowed: string[],
  definitions: Record<string, { label?: string; fields: Record<string, FieldDef> }>,
  document: Record<string, unknown>,
): Html {
  const blocks = Array.isArray(document.blocks)
    ? (document.blocks as Array<Record<string, unknown>>)
    : [];

  if (blocks.length === 0) {
    return html`<p class="empty">No blocks yet. Add one to see it here.</p>`;
  }

  return html`${blocks.map((block) => {
    const type = String(block._type ?? "");
    const definition = definitions[type];
    return html`
      <section class="block">
        <p class="kind">${definition?.label ?? type}</p>
        ${definition ? renderFields(definition.fields, block) : html`<p class="empty">Unknown block type.</p>`}
      </section>
    `;
  })}`;
}

function renderField(def: FieldDef, name: string, value: unknown): Html {
  const label = def.label ?? humanize(name);

  switch (def.type) {
    case "text": {
      const text = typeof value === "string" ? value : "";
      if (!text) return blank(label);
      // A short single-line text field is almost always a heading of some kind;
      // rendering it at heading weight makes the preview read like a page.
      return def.multiline
        ? html`<p>${text}</p>`
        : html`<p class="${text.length <= 90 ? "headline" : ""}">${text}</p>`;
    }

    case "richtext": {
      const source = typeof value === "string" ? value : (value as { html?: string })?.html;
      if (!source) return blank(label);
      // Already sanitized on the way in; rendered inside a sandboxed iframe with
      // scripting disabled, so there is nowhere for markup to escape to.
      return html`<div class="rich">${raw(source)}</div>`;
    }

    case "image": {
      const image = value as { src?: string; alt?: string; width?: number; height?: number };
      if (!image?.src) return blank(label);
      return html`
        <figure>
          <img
            src="${image.src}"
            alt="${image.alt ?? ""}"
            width="${image.width ?? undefined}"
            height="${image.height ?? undefined}"
          />
          ${image.alt ? html`<figcaption>alt: ${image.alt}</figcaption>` : html`<figcaption class="warn">No alt text</figcaption>`}
        </figure>
      `;
    }

    case "link": {
      const link = value as { href?: string; label?: string };
      if (!link?.href) return blank(label);
      return html`<p><a href="${link.href}">${link.label ?? link.href}</a></p>`;
    }

    case "boolean":
      return html`<p class="meta">${label}: ${value ? "yes" : "no"}</p>`;

    case "select": {
      const chosen = Array.isArray(value) ? value.join(", ") : String(value ?? "");
      if (!chosen) return blank(label);
      const known = selectOptions(def).find((option) => option.value === chosen);
      return html`<p class="meta">${label}: ${known?.label ?? chosen}</p>`;
    }

    case "number":
    case "date":
      return value === undefined || value === ""
        ? blank(label)
        : html`<p class="meta">${label}: ${String(value)}</p>`;

    case "list": {
      const items = Array.isArray(value) ? value : [];
      if (items.length === 0) return blank(label);
      return html`
        <ul>
          ${items.map((item) => html`<li>${renderField(def.of, label, item)}</li>`)}
        </ul>
      `;
    }

    case "group":
      return html`
        <div class="group">
          ${renderFields(def.fields, (value ?? {}) as Record<string, unknown>)}
        </div>
      `;

    default:
      return blank(label);
  }
}

function blank(label: string): Html {
  return html`<p class="empty">${label} — empty</p>`;
}

function humanize(name: string): string {
  const spaced = name.replace(/[-_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const STYLES = `
:root { color-scheme: light dark; --ink: #1a1a17; --soft: #5c5b52; --faint: #9a9789; --paper: #fff; --line: #e2ded3; --warn: #8c1d18; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #ece9e1; --soft: #a8a49a; --faint: #6c6a60; --paper: #16161300; --line: #35342c; --warn: #ffb4ab; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem 1.6rem 3rem; background: var(--paper); color: var(--ink);
  font: 16px/1.6 ui-serif, Georgia, "Times New Roman", serif; }
main { max-width: 42rem; margin: 0 auto; }
p { margin: 0 0 .85rem; }
.headline { font-size: 1.5rem; line-height: 1.2; font-weight: 600; letter-spacing: -.015em; margin-bottom: .6rem; }
.meta, .kind, figcaption { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; letter-spacing: .02em; color: var(--faint); }
.kind { text-transform: uppercase; margin: 0 0 .5rem; }
.empty { color: var(--faint); font-style: italic; font-size: .9rem; }
.block { padding: 1.1rem 0; border-top: 1px dashed var(--line); }
.block:first-child { border-top: 0; padding-top: 0; }
.group { padding-left: .9rem; border-left: 2px solid var(--line); }
.rich :is(h1,h2,h3) { line-height: 1.25; margin: 1.2rem 0 .4rem; }
.rich blockquote { margin: .8rem 0; padding-left: .9rem; border-left: 3px solid var(--line); color: var(--soft); }
.rich code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
figure { margin: 0 0 1rem; }
img { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; display: block; }
figcaption { margin-top: .35rem; }
figcaption.warn { color: var(--warn); }
ul { margin: 0 0 .9rem; padding-left: 1.2rem; }
a { color: inherit; }
`;
