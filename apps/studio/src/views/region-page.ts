/** Editing one region, its fields or its blocks. */

import type { BlockDef, CmsSchema, RegionDef } from "@greatcms/spec";
import type { Elsewhere } from "../elsewhere.js";
import { isBlocksRegion } from "@greatcms/spec";
import { html } from "hono/html";
import type { Site } from "../db.js";
import { fieldName } from "../form.js";
import { type ErrorsByPath, hasRichText, renderFields } from "./fields.js";
import { page, type PageOptions, splitWidth } from "./layout.js";
import { icon } from "./icons.js";
import { removeBlockControl } from "./block-actions.js";
import { summarize, variantField, variantLabel } from "./summary.js";
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

export interface EditPageOptions {
  mediaPreviews?: Record<string, string>;
  pendingMedia?: string;
  site: Site;
  schema: CmsSchema;
  regionId: string;
  region: RegionDef;
  /** The content file, relative to the site, that publishing writes. */
  file?: string;
  document: Record<string, unknown>;
  errors: ErrorsByPath;
  headSha: string;
  flash?: PageOptions["flash"];
  /** The form holds an unsaved edit from earlier rather than what is published. */
  draft?: boolean;
  /** That edit began before a newer publish of the same content. */
  staleDraft?: boolean;
  /** Other people who had this open in the last few minutes. */
  others?: Array<{ name: string; seenAt: number }>;
  /** Images already on the site, offered by every image field. */
  media?: string[];
  /** Each collection's entries, offered by reference fields. */
  entries?: Record<string, Array<{ slug: string; title: string }>>;
  /** The page the preview opens; defaults to the site's dev server root. */
  previewUrl?: string;
  running?: boolean | null;
  /** Keep the section affected by a form action open after the server round trip. */
  openBlock?: number;
  /** Keep the nested item affected by a form action open after the server round trip. */
  openNested?: string;
  /** The site's other regions, so the page's header and footer are reachable from here too. */
  elsewhere?: Elsewhere[];
}

export function editRegionPage(options: EditPageOptions): string {
  const {
    site,
    schema,
    regionId,
    region,
    document,
    errors,
    headSha,
    flash,
    openBlock,
    openNested,
  } = options;
  const title = region.label ?? regionId;

  const editor = isBlocksRegion(region)
    ? region.allow.some((type) =>
        hasRichText(schema.blocks[type]?.fields ?? {}, new Set(), schema.blocks, new Set([type])),
      )
    : hasRichText(region.fields, new Set(), schema.blocks);

  return page(
    {
      title,
      section: "sites",
      site: siteNav(site, schema, `regions/${regionId}`),
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
        { href: `/sites/${site.id}/regions/${regionId}`, label: title },
      ],
      flash,
      editor,
      liveSite: true,
    },
    html`
      <div class="page-head">
        <h1>${title}</h1>
        <p class="lede">
          Saved to <code>${options.file ?? regionId}</code>; publishing commits it.
          <a class="head-link" href="/sites/${site.id}/regions/${regionId}/history"
            >${icon("history")} History</a
          >
        </p>
      </div>

      <div class="split" ${splitWidth()}>
        <form
          method="POST"
          action="/sites/${site.id}/regions/${regionId}"
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
            <a class="button secondary" href="/sites/${site.id}">Back to site</a>
            ${scheduleControl()}
          </div>
          ${presenceNotice(options.others)}
          ${
            options.draft
              ? draftNotice(
                  `/sites/${site.id}/regions/${regionId}/draft/discard`,
                  options.staleDraft,
                )
              : ""
          }
          ${
            isBlocksRegion(region)
              ? renderBlocks(
                  schema,
                  region,
                  document,
                  errors,
                  openBlock,
                  openNested,
                  options.mediaPreviews,
                )
              : renderFields(region.fields, document, errors, [], {
                  blocks: schema.blocks,
                  openNested,
                  mediaPreviews: options.mediaPreviews,
                  lang: schema.site?.locale,
                })
          }
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
          draft: `/sites/${site.id}/regions/${regionId}/draft`,
          url: options.previewUrl,
          elsewhere: options.elsewhere,
          running: options.running,
          empty: html`<p>
            <a href="/sites/${site.id}/settings">Add your dev server's URL</a>, and your edits will
            render here in your own components as you type.
          </p>`,
        })}
      </div>
    `,
  );
}

function renderBlocks(
  schema: CmsSchema,
  region: Extract<RegionDef, { type: "blocks" }>,
  document: Record<string, unknown>,
  errors: ErrorsByPath,
  openBlock?: number,
  openNested?: string,
  mediaPreviews?: Record<string, string>,
) {
  const blocks = Array.isArray(document.blocks)
    ? (document.blocks as Array<Record<string, unknown>>)
    : [];

  return html`
    ${
      blocks.length > 2
        ? html`
            <nav class="outline" aria-label="Sections on this page">
              <p class="stamp">${blocks.length} sections</p>
              <ol>
                ${blocks.map(
                  (block, index) => html`<li>
                    <a href="#block-${index}"
                      >${schema.blocks[String(block._type ?? "")]?.label ?? String(block._type ?? "")}
                      <span
                        >${blockSummary(block, schema.blocks[String(block._type ?? "")])}</span
                      ></a
                    >
                  </li>`,
                )}
              </ol>
              <a class="outline-add" href="#add-block">${icon("plus")} Add a section</a>
            </nav>
          `
        : ""
    }
    ${blocks.map((block, index) => {
      const type = String(block._type ?? "");
      const definition = schema.blocks[type];
      const name = fieldName(["blocks", index, "_type"]);
      const hasError = [...errors.keys()].some((path) => path.startsWith(`blocks[${index}]`));
      return html`
        <section
          class="block block-collapsible"
          id="block-${index}"
          aria-label="${definition?.label ?? type} (position ${index + 1})"
        >
          <details ${openBlock === index || hasError ? "open" : ""}>
            <summary>
              <h2>${definition?.label ?? type}</h2>
              <span>${blockSummary(block, definition)} · Section ${index + 1}</span>
            </summary>
            <div class="block-fields">
              <input type="hidden" name="${name}" value="${type}" />
              ${variantField(
                block,
                definition,
                fieldName(["blocks", index, "_variant"]),
                `f-blocks-${index}-_variant`,
              )}
              ${
                definition
                  ? renderFields(definition.fields, block, errors, ["blocks", index], {
                      blocks: schema.blocks,
                      openNested,
                      mediaPreviews,
                      lang: schema.site?.locale,
                    })
                  : html`<p class="error-text">
                      This section type is no longer in the schema. Publishing will drop it.
                    </p>`
              }
            </div>
          </details>
          <div
            class="tools"
            role="group"
            aria-label="Reorder or remove ${definition?.label ?? type}"
          >
            <button
              type="submit"
              name="action"
              value="up:${index}"
              aria-label="Move ${definition?.label ?? type} up"
              title="Move up"
              formnovalidate
              ${index === 0 ? "disabled" : ""}
            >
              ${icon("up")}
            </button>
            <button
              type="submit"
              name="action"
              value="down:${index}"
              aria-label="Move ${definition?.label ?? type} down"
              title="Move down"
              formnovalidate
              ${index === blocks.length - 1 ? "disabled" : ""}
            >
              ${icon("down")}
            </button>
            ${removeBlockControl(`${definition?.label ?? type} (section ${index + 1})`, `remove:${index}`)}
          </div>
        </section>
      `;
    })}

    <div class="add-block" id="add-block">
      <div class="field">
        <label for="add-block-type">Add a section</label>
        <select id="add-block-type" name="addType">
          ${region.allow.map(
            (type) => html`<option value="${type}">${schema.blocks[type]?.label ?? type}</option>`,
          )}
        </select>
      </div>
      <button class="secondary" type="submit" name="action" value="add" formnovalidate>
        Add section
      </button>
    </div>
  `;
}

function blockSummary(block: Record<string, unknown>, definition?: BlockDef): string {
  const variant = variantLabel(block, definition);
  return `${summarize(block, definition, "Empty section")}${variant ? ` · ${variant}` : ""}`;
}

export function describeRegion(region: RegionDef): string {
  if (isBlocksRegion(region)) {
    return `block list (${region.allow.join(", ")})`;
  }
  const count = Object.keys(region.fields).length;
  return `${count} field${count === 1 ? "" : "s"}`;
}
