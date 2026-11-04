/** A collection's entries, and editing one entry. */

import {
  entryExtension,
  type BlockDef,
  type CmsSchema,
  type CollectionFormat,
  type FieldDef,
} from "@greatcms/spec";
import type { Elsewhere } from "../elsewhere.js";
import { html } from "hono/html";
import type { Site } from "../db.js";
import { type ErrorsByPath, hasRichText, renderFields } from "./fields.js";
import { page, type PageOptions } from "./layout.js";
import { icon } from "./icons.js";
import { ago } from "./locale.js";
import {
  draftNotice,
  entryLists,
  livePanel,
  mediaList,
  pendingMediaNotice,
  presenceNotice,
  scheduleControl,
  siteNav,
} from "./editor-parts.js";

export function collectionPage(options: {
  site: Site;
  schema: CmsSchema;
  name: string;
  label: string;
  entryLabel?: string;
  entries: Array<{
    slug: string;
    title: string;
    summary?: string;
    draft?: boolean;
    edited?: { author: string; date: string };
  }>;
  flash?: PageOptions["flash"];
}): string {
  const { site, name, label, entries, flash } = options;
  const entryLabel = options.entryLabel ?? "entry";

  return page(
    {
      title: label,
      section: "sites",
      site: siteNav(site, options.schema, `collections/${name}`),
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
        { href: `/sites/${site.id}/collections/${name}`, label },
      ],
      flash,
    },
    html`
      <div class="page-head">
        <div class="section-head">
          <h1>${label}</h1>
          ${
            entries.length > 0
              ? html`<a class="button" href="/sites/${site.id}/collections/${name}/new">
                  ${icon("plus")} Add ${entryLabel}
                </a>`
              : ""
          }
        </div>
        <p class="lede">
          ${entries.length > 0 ? `${entries.length} ${entries.length === 1 ? entryLabel : plural(entryLabel)}. ` : ""}Each
          ${entryLabel} is a file in
          <code>${options.schema.collections[name]?.path ?? name}/</code>.
        </p>
      </div>

      ${
        entries.length === 0
          ? html`
              <div class="empty">
                <h2>No ${label.toLocaleLowerCase()} yet</h2>
                <p>The first ${entryLabel} becomes a file when you publish it.</p>
                <a class="button" href="/sites/${site.id}/collections/${name}/new">
                  Add the first ${entryLabel}
                </a>
              </div>
            `
          : html`
              <ul class="entry-list" role="list">
                ${entries.map(
                  (entry) => html`
                    <li>
                      <a
                        href="/sites/${site.id}/collections/${name}/${encodeURIComponent(entry.slug)}"
                      >
                        <strong>${entry.title}</strong>
                        <span class="summary">${entry.summary ?? ""}</span>
                        <span
                          class="entry-meta"
                          title="${entry.edited ? `Last edited by ${entry.edited.author}` : entry.slug}"
                          >${entry.draft ? html`<span class="badge warn">Unsaved edits</span>` : entry.edited ? ago(entry.edited.date) : html`<code>${entry.slug}</code>`}</span
                        >
                      </a>
                    </li>
                  `,
                )}
              </ul>
            `
      }

      <div class="actions">
        <a class="button secondary" href="/sites/${site.id}">${icon("back")} Back to site</a>
      </div>
    `,
  );
}

export function editEntryPage(options: {
  mediaPreviews?: Record<string, string>;
  pendingMedia?: string;
  site: Site;
  schema: CmsSchema;
  draft?: boolean;
  staleDraft?: boolean;
  others?: Array<{ name: string; seenAt: number }>;
  media?: string[];
  entries?: Record<string, Array<{ slug: string; title: string }>>;
  previewUrl?: string;
  running?: boolean | null;
  elsewhere?: Elsewhere[];
  name: string;
  label: string;
  entryLabel?: string;
  /** The field whose value names this entry to a person, usually the one the slug comes from. */
  titleField?: string;
  slug: string | null;
  fields: Record<string, FieldDef>;
  /** How entries are stored, which decides whether the body is prose or source. */
  format?: CollectionFormat;
  /** The field holding the body, when there is one. */
  body?: string;
  /** Block definitions, for any nested `blocks` field on this entry. */
  blocks?: Record<string, BlockDef>;
  document: Record<string, unknown>;
  errors: ErrorsByPath;
  headSha: string;
  flash?: PageOptions["flash"];
  openNested?: string;
}): string {
  const { site, name, label, slug, fields, document, errors, headSha, flash } = options;
  const entryLabel = options.entryLabel ?? "entry";
  const titled = options.titleField ? String(document[options.titleField] ?? "").trim() : "";
  const heading = titled || slug || `New ${entryLabel}`;
  // MDX bodies are edited as source: the JSX in them is not HTML to round trip.
  const plain =
    options.format === "mdx" && options.body ? new Set([options.body]) : new Set<string>();
  const title = slug ? `${label}: ${slug}` : `New ${entryLabel}`;
  const action = `/sites/${site.id}/collections/${name}/${encodeURIComponent(slug ?? "new")}`;

  return page(
    {
      title,
      section: "sites",
      site: siteNav(site, options.schema, `collections/${name}`),
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
        { href: `/sites/${site.id}/collections/${name}`, label },
        { href: action, label: slug ? heading : "New entry" },
      ],
      flash,
      editor: hasRichText(fields, plain, options.schema.blocks),
      liveSite: true,
    },
    html`
      <div class="page-head">
        <h1>${heading}</h1>
        <p class="lede">
          ${
            slug
              ? html`Saved to <code>${entryFile(options.schema, name, slug, options.format)}</code>;
                  publishing commits it.
                  <a class="head-link" href="${action}/history">${icon("history")} History</a>`
              : html`The file name is derived from this ${entryLabel}'s title when you save it.`
          }
        </p>
      </div>

      <div class="split">
        <form
          method="POST"
          action="${action}"
          enctype="multipart/form-data"
          data-editor-form
          id="editor-form"
        >
          <input type="hidden" name="headSha" value="${headSha}" />
          ${mediaList(options.media)} ${entryLists(options.entries)}
          ${pendingMediaNotice(options.pendingMedia)}
          <div class="form-actions">
            <button
              type="submit"
              name="action"
              value="publish"
              aria-keyshortcuts="Control+Enter Meta+Enter"
            >
              Publish
            </button>
            <a class="button secondary" href="/sites/${site.id}/collections/${name}">Cancel</a>
            ${slug ? scheduleControl() : ""}
          </div>
          ${presenceNotice(options.others)}
          ${options.draft && slug ? draftNotice(`${action}/draft/discard`, options.staleDraft) : ""}
          ${renderFields(fields, document, errors, [], {
            plain,
            blocks: options.blocks,
            openNested: options.openNested,
            mediaPreviews: options.mediaPreviews,
            lang: options.schema.site?.locale,
          })}
        </form>

        <div
          class="handle split-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the preview"
          aria-valuenow="0"
          tabindex="0"
          data-resize-live
          hidden
        ></div>

        ${livePanel(site, {
          draft: slug ? `${action}/draft` : undefined,
          url: options.previewUrl,
          elsewhere: options.elsewhere,
          running: options.running,
          empty: html`<p>
            ${
              slug
                ? html`<a href="/sites/${site.id}/settings">Add your dev server's URL</a> to see
                    this entry render as you type.`
                : "A new entry renders here once it has been published, since your site has no file to read yet."
            }
          </p>`,
        })}
      </div>

      ${
        slug
          ? html`
              <section class="danger-zone" aria-labelledby="delete">
                <h2 id="delete">Delete</h2>
                <p>Removes <code>${slug}</code> from the repository in one commit.</p>
                <details class="danger-confirm">
                  <summary>Delete this entry</summary>
                  <p>This creates a commit that removes <code>${slug}</code>.</p>
                  <form method="POST" action="${action}/delete">
                    <button class="danger" type="submit">Confirm delete this entry</button>
                  </form>
                </details>
              </section>
            `
          : ""
      }
    `,
  );
}

/** The entry's file relative to the site, the thing a publish changes. */
function entryFile(schema: CmsSchema, name: string, slug: string, format?: CollectionFormat) {
  const folder = schema.collections[name]?.path.replace(/\/+$/, "") ?? name;
  return `${folder}/${slug}.${entryExtension(format ?? "json")}`;
}

/** Enough English for an entry label: "item" → "items", "entry" → "entries". */
export function plural(word: string): string {
  return /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
}
