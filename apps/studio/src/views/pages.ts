import type { BlockDef, CmsSchema, CollectionFormat, FieldDef, RegionDef } from "@greatcms/spec";
import type { Elsewhere } from "../elsewhere.js";
import { isBlocksRegion } from "@greatcms/spec";
import { html, raw } from "hono/html";
import type { Publish, Site, Submission } from "../db.js";
import type { SyncState } from "../repo.js";
import type { UnsavedDraft } from "../sites.js";
import { fieldName } from "../form.js";
import { type ErrorsByPath, hasRichText, renderFields } from "./fields.js";
import { brandMark, page, type PageOptions, type SiteNav } from "./layout.js";
import { icon } from "./icons.js";
import { locale } from "./locale.js";
import { removeBlockControl } from "./block-actions.js";
import { summarize, variantField, variantLabel } from "./summary.js";

/** The preview beside an editor: the site's own dev server, framed, with a phone-width toggle. */
function livePanel(
  site: Site,
  options: {
    draft?: string;
    url?: string;
    empty: ReturnType<typeof html>;
    elsewhere?: Elsewhere[];
  },
) {
  const url = options.url ?? site.devUrl ?? undefined;
  const framed = url && options.draft;
  // JSON in a script element is inert; only `<` needs hiding so no value can close the element.
  const elsewhere = JSON.stringify(options.elsewhere ?? []).replace(/</g, "\\u003c");
  return html`
    <aside class="live" aria-labelledby="live-heading">
      <div class="live-bar">
        <h2 id="live-heading">Live preview</h2>
        ${url ? html`<span class="live-url">${url.replace(/^https?:\/\//, "")}</span>` : ""}
        ${
          framed
            ? html`
                <div class="live-tools">
                  <label class="live-toggle" hidden title="Point at the page to find what to edit">
                    <input type="checkbox" id="live-select" />
                    ${icon("pointer")} <span>Select</span>
                  </label>
                  <label class="live-toggle" hidden title="Outline every section on the page">
                    <input type="checkbox" id="live-sections" />
                    ${icon("layout")} <span>Sections</span>
                  </label>
                  <div class="live-devices" role="group" aria-label="Preview width">
                    <input type="radio" name="device" id="device-desktop" checked />
                    <label for="device-desktop" title="Desktop width"
                      >${icon("monitor", "Desktop width")}</label
                    >
                    <input type="radio" name="device" id="device-phone" />
                    <label for="device-phone" title="Phone width"
                      >${icon("phone", "Phone width")}</label
                    >
                  </div>
                  <button
                    class="icon-button"
                    type="button"
                    data-live-reload
                    hidden
                    title="Reload the site"
                  >
                    ${icon("refresh", "Reload the site")}
                  </button>
                  <a
                    class="icon-button"
                    href="${url}"
                    target="_blank"
                    rel="noopener"
                    title="Open in a new tab"
                    >${icon("external", "Open in a new tab")}</a
                  >
                </div>
              `
            : ""
        }
        <p class="muted" id="live-status" role="status">
          ${url ? "Showing what is published" : "No dev server connected"}
        </p>
      </div>
      ${
        framed
          ? html`
              <div class="live-stage">
                <iframe
                  title="Your site, running locally"
                  class="live-frame real"
                  src="${url}"
                  data-live-site="${options.draft}"
                ></iframe>
              </div>
              <script type="application/json" id="live-elsewhere">
                ${raw(elsewhere)}
              </script>
              <div class="live-actions">
                <p class="hint">
                  Your real components, showing what is in the form. Edits are written to
                  <code>.cms/draft/</code> for your dev server, never committed until you publish.
                </p>
                <details class="inline-confirm">
                  <summary>Discard unsaved edits</summary>
                  <form method="POST" action="${options.draft}/discard">
                    <button class="danger" type="submit">Confirm discard</button>
                  </form>
                </details>
              </div>
            `
          : html`<div class="live-empty">
              <div>${icon("monitor")} ${options.empty}</div>
            </div>`
      }
    </aside>
  `;
}

function pendingMediaNotice(token?: string) {
  return token
    ? html`<input type="hidden" name="pendingMedia" value="${token}" />
        <p class="hint" role="status">
          Selected images are kept for this form for 24 hours. Publish to save them with your
          content; keep this tab open until then.
        </p>`
    : "";
}

/** The sidebar's map of a site: every region and collection, with the one being edited marked. */
function siteNav(site: Site, schema: CmsSchema, current?: string): SiteNav {
  return {
    id: site.id,
    name: site.name,
    devUrl: site.devUrl,
    collections: Object.entries(schema.collections).map(([name, collection]) => ({
      name,
      label: collection.label ?? name,
    })),
    regions: Object.entries(schema.regions).map(([id, region]) => ({
      id,
      label: region.label ?? id,
    })),
    current,
  };
}

/**
 * An earlier edit is waiting in the form: say so, since publishing now would publish it.
 * Sits inside the editor form, so discarding is a button aimed at the discard route
 * rather than a form of its own.
 */
function draftNotice(discard: string) {
  return html`
    <div class="draft-notice" role="status">
      ${icon("pen")}
      <p>
        <strong>Unsaved edits restored.</strong> The form and the preview show what you were editing
        last time; nothing is published until you publish.
      </p>
      <details class="inline-confirm">
        <summary>Discard them</summary>
        <button class="danger" type="submit" formaction="${discard}" formnovalidate>
          Discard unsaved edits
        </button>
      </details>
    </div>
  `;
}

export function signInPage(options: { error?: string; next?: string } = {}): string {
  // A `next` that is a full address is a sibling host, such as the preview, asking us to vouch.
  const onward = options.next?.startsWith("/") === false ? new URL(options.next).host : null;
  return page(
    {
      title: "Sign in",
      chrome: false,
      flash: options.error ? { kind: "error", message: options.error } : undefined,
    },
    html`
      <div class="sign-in-card">
        <p class="brand">
          ${brandMark()}
          <span>GreatCMS <small>Studio</small></span>
        </p>
        <div class="page-head">
          <h1>Sign in</h1>
          <p class="lede">
            ${
              onward
                ? html`One password for the studio and the preview. You will continue to
                    <code>${onward}</code>.`
                : html`Edit the sites connected to this studio. Content stays in their repositories.`
            }
          </p>
        </div>
        <form method="POST" action="/sign-in">
          ${options.next ? html`<input type="hidden" name="next" value="${options.next}" />` : ""}
          <div class="field">
            <label for="password">Password</label>
            <input
              type="password"
              id="password"
              name="password"
              autocomplete="current-password"
              required
            />
          </div>
          <div class="actions"><button type="submit">Sign in</button></div>
        </form>
      </div>
    `,
  );
}

export function sitesPage(sites: Site[], unread = 0, flash?: PageOptions["flash"]): string {
  return page(
    { title: "Sites", flash, section: "sites", unread },
    html`
      <div class="page-head">
        <div class="section-head">
          <h1>Sites</h1>
          ${sites.length > 0 ? html`<a class="button" href="/sites/new">${icon("plus")} Connect a site</a>` : ""}
        </div>
        <p class="lede">Every site the studio can edit. Content lives in your repository.</p>
      </div>

      ${
        sites.length === 0
          ? html`
              <div class="empty">
                <h2>No sites yet</h2>
                <p>
                  Point the studio at a folder on this machine. It needs a
                  <code>.cms/schema.yaml</code> file describing what is editable.
                </p>
                <a class="button" href="/sites/new">Connect your first site</a>
              </div>
            `
          : html`
              <ul class="cards two">
                ${sites.map(
                  (site) => html`
                    <li class="card">
                      <div class="card-topline">
                        <h2><a href="/sites/${site.id}">${site.name}</a></h2>
                        <span class="status ${site.devUrl ? "ready" : "idle"}">
                          ${site.devUrl ? "Preview ready" : "Folder connected"}
                        </span>
                      </div>
                      <p class="path"><code>${site.path}</code></p>
                      ${site.devUrl ? html`<p class="path"><code>${site.devUrl}</code></p>` : ""}
                    </li>
                  `,
                )}
              </ul>
            `
      }
    `,
  );
}

/** A field's hint, plus its error when there is one, for aria-describedby. */
function describedBy(hint: string, error?: string): string {
  return error ? `${hint} ${hint}-error` : hint;
}

export function newSitePage(
  options: {
    error?: string;
    values?: Record<string, string>;
    fieldErrors?: { path?: string; devUrl?: string };
    /** Present when changing a connected site rather than connecting a new one. */
    editing?: Site;
  } = {},
): string {
  const { editing, fieldErrors = {} } = options;
  const values = options.values ?? (editing ? { ...editing } : {});
  const title = editing ? "Site settings" : "Connect a site";
  const action = editing ? `/sites/${editing.id}/settings` : "/sites";

  return page(
    {
      title,
      section: "sites",
      site: editing,
      crumbs: [
        { href: "/", label: "Sites" },
        ...(editing ? [{ href: `/sites/${editing.id}`, label: editing.name }] : []),
        { href: editing ? action : "/sites/new", label: title },
      ],
      flash: options.error ? { kind: "error", message: options.error } : undefined,
    },
    html`
      <div class="page-head">
        <h1>${title}</h1>
        <p class="lede">
          ${
            editing
              ? html`Change what this studio calls the site and where its dev server runs. The
                folder stays the same: connect a new site to point at a different one.`
              : html`A folder on this machine containing a <code>.cms/schema.yaml</code>. The studio
                  reads it to build the editor — it never runs any code from your site.`
          }
        </p>
      </div>

      <form method="POST" action="${action}">
        <div class="field">
          <label for="name">Name</label>
          <input
            type="text"
            id="name"
            name="name"
            value="${values.name ?? ""}"
            autocomplete="off"
            required
          />
          <span class="hint">What you will call it in this studio.</span>
        </div>

        <div class="field">
          <label for="path">Folder path</label>
          <input
            type="text"
            id="path"
            name="path"
            value="${values.path ?? ""}"
            placeholder="/home/you/projects/my-site"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="${describedBy("path-hint", fieldErrors.path)}"
            ${fieldErrors.path ? html`aria-invalid="true"` : ""}
            ${editing ? html`readonly` : html`required`}
          />
          <span class="hint" id="path-hint">
            The directory containing <code>.cms/schema.yaml</code>. Publishing writes the files and
            commits them if it is a Git repository.
          </span>
          ${
            fieldErrors.path
              ? html`<p class="error-text" id="path-hint-error">${fieldErrors.path}</p>`
              : ""
          }
        </div>

        <div class="field">
          <label for="devUrl">Dev server URL <span class="tag">optional</span></label>
          <input
            type="url"
            id="devUrl"
            name="devUrl"
            value="${values.devUrl ?? ""}"
            placeholder="http://localhost:4321"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="${describedBy("dev-hint", fieldErrors.devUrl)}"
            ${fieldErrors.devUrl ? html`aria-invalid="true"` : ""}
          />
          <span class="hint" id="dev-hint">
            If set, the editor shows your real site beside the form — your own components, rendering
            what you are typing.
          </span>
          ${
            fieldErrors.devUrl
              ? html`<p class="error-text" id="dev-hint-error">${fieldErrors.devUrl}</p>`
              : ""
          }
        </div>

        ${
          editing
            ? html`
                <div class="field">
                  <div class="checkbox">
                    <input
                      type="checkbox"
                      id="pushAfterPublish"
                      name="pushAfterPublish"
                      aria-describedby="push-hint"
                      ${editing.pushAfterPublish ? html`checked` : ""}
                    />
                    <label for="pushAfterPublish">Push after every publish</label>
                  </div>
                  <span class="hint" id="push-hint">
                    Sends each publish to the branch's upstream, so your host deploys it without
                    anyone running Git. Uses this machine's Git credentials; hooks never run.
                  </span>
                </div>
              `
            : ""
        }

        <div class="form-actions">
          <button type="submit">${editing ? "Save" : "Connect"}</button>
          <a class="button secondary" href="${editing ? `/sites/${editing.id}` : "/"}">Cancel</a>
        </div>
      </form>
    `,
  );
}

export function sitePage(
  site: Site,
  schema: CmsSchema,
  publishes: Publish[],
  flash?: PageOptions["flash"],
  drafts: UnsavedDraft[] = [],
  /** This site's form address, e.g. https://studio.example.com/f/<id>. */
  formsEndpoint?: string,
  sync?: SyncState | null,
): string {
  const regions = Object.entries(schema.regions);
  const collections = Object.entries(schema.collections);

  return page(
    {
      title: site.name,
      section: "sites",
      site: siteNav(site, schema),
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
      ],
      flash,
    },
    html`
      <div class="page-head">
        <div class="section-head">
          <h1>${site.name}</h1>
          <a class="button secondary" href="/sites/${site.id}/settings"
            >${icon("settings")} Site settings</a
          >
        </div>
        <p class="lede">
          Choose a part of the site to edit. Its content stays in your working copy.
        </p>
      </div>

      <dl class="workspace-meta" aria-label="Connected site details">
        <div>
          <dt>Working copy</dt>
          <dd><code>${site.path}</code></dd>
        </div>
        <div>
          <dt>Live preview</dt>
          <dd>
            ${
              site.devUrl
                ? html`<span class="status ready">Connected</span>
                    <span class="hint"><code>${site.devUrl}</code></span>`
                : html`<a href="/sites/${site.id}/settings">Add your dev server</a>`
            }
          </dd>
        </div>
        <div>
          <dt>Publishing</dt>
          <dd>
            ${site.pushAfterPublish ? html`One commit, pushed to <code>${sync?.upstream ?? "its upstream"}</code>` : "One commit"}
          </dd>
        </div>
      </dl>

      ${
        sync && sync.ahead > 0
          ? html`
              <form class="unpushed" method="POST" action="/sites/${site.id}/push" role="status">
                <p>
                  <strong
                    >${sync.ahead} ${sync.ahead === 1 ? "publish" : "publishes"} not pushed
                    yet.</strong
                  >
                  They are committed in the working copy and not yet on
                  <code>${sync.upstream}</code>.
                </p>
                <button type="submit">Push now</button>
              </form>
            `
          : ""
      }
      ${
        drafts.length > 0
          ? html`
              <div class="drafts" role="status">
                <h2>Unsaved edits</h2>
                <p>
                  Your dev server is showing these instead of what is published. Nothing here is
                  committed.
                </p>
                <ul>
                  ${drafts.map(
                    (draft) => html`
                      <li><a href="${draft.href}">${draft.label}</a> <code>${draft.path}</code></li>
                    `,
                  )}
                </ul>
              </div>
            `
          : ""
      }

      <section class="resource-section" aria-labelledby="regions-heading">
        <div class="resource-heading">
          <h2 id="regions-heading">Page regions</h2>
          <span>${regions.length} editable ${regions.length === 1 ? "area" : "areas"}</span>
        </div>
        <ul class="cards two">
          ${regions.map(
            ([id, region]) => html`
              <li class="card">
                <h3><a href="/sites/${site.id}/regions/${id}">${region.label ?? id}</a></h3>
                <p><code>${id}</code> · ${describeRegion(region)}</p>
              </li>
            `,
          )}
        </ul>
      </section>

      ${
        collections.length > 0
          ? html`
              <section class="resource-section" aria-labelledby="collections-heading">
                <div class="resource-heading">
                  <h2 id="collections-heading">Collections</h2>
                  <span
                    >${collections.length} structured
                    ${collections.length === 1 ? "list" : "lists"}</span
                  >
                </div>
                <ul class="cards two">
                  ${collections.map(
                    ([name, collection]) => html`
                      <li class="card">
                        <div class="card-topline">
                          <h3>
                            <a href="/sites/${site.id}/collections/${name}">
                              ${collection.label ?? name}
                            </a>
                          </h3>
                          <a class="card-action" href="/sites/${site.id}/collections/${name}/new">
                            Add ${collection.entryLabel ?? "entry"}
                          </a>
                        </div>
                        <p><code>${collection.path}</code> · ${collection.format}</p>
                      </li>
                    `,
                  )}
                </ul>
              </section>
            `
          : ""
      }
      ${
        publishes.length > 0
          ? html`
              <section class="resource-section" aria-labelledby="publishes-heading">
                <div class="resource-heading">
                  <h2 id="publishes-heading">Recent publishes</h2>
                  <span>${publishes.length} ${publishes.length === 1 ? "commit" : "commits"}</span>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Region</th>
                      <th scope="col">When</th>
                      <th scope="col">Commit</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${publishes.map(
                      (entry) => html`
                        <tr>
                          <td><code>${entry.region_id}</code></td>
                          <td>${when(entry.created_at)}</td>
                          <td>
                            <code>${entry.commit_sha.slice(0, 7)}</code>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </section>
            `
          : ""
      }
      ${
        formsEndpoint
          ? html`
              <section class="resource-section" aria-labelledby="forms">
                <div class="resource-heading">
                  <h2 id="forms">Forms</h2>
                  <span>Plain HTML, no script</span>
                </div>
                <p class="muted">
                  A plain HTML form on this site can post here, and what visitors send lands in the
                  <a href="/inbox?site=${encodeURIComponent(site.id)}">inbox</a>. The last part of
                  the address names the form, so one site can have several.
                </p>
                <pre><code>&lt;form method="POST" action="${formsEndpoint}/contact"&gt;
  &lt;label for="email"&gt;Email&lt;/label&gt;
  &lt;input id="email" name="email" type="email" required&gt;
  &lt;label for="message"&gt;Message&lt;/label&gt;
  &lt;textarea id="message" name="message" required&gt;&lt;/textarea&gt;
  &lt;input type="hidden" name="_redirect" value="/thanks/"&gt;
  &lt;button&gt;Send&lt;/button&gt;
&lt;/form&gt;</code></pre>
              </section>
            `
          : ""
      }

      <section class="danger-zone" aria-labelledby="danger">
        <h2 id="danger">Danger zone</h2>
        <p>Disconnects this site from the studio. Nothing is deleted from ${site.path}.</p>
        <details class="danger-confirm">
          <summary>Disconnect this site</summary>
          <p>Confirm that you want to remove this studio connection.</p>
          <form method="POST" action="/sites/${site.id}/delete">
            <button class="danger" type="submit">Confirm disconnect ${site.name}</button>
          </form>
        </details>
      </section>
    `,
  );
}

export interface EditPageOptions {
  mediaPreviews?: Record<string, string>;
  pendingMedia?: string;
  site: Site;
  schema: CmsSchema;
  regionId: string;
  region: RegionDef;
  document: Record<string, unknown>;
  errors: ErrorsByPath;
  headSha: string;
  flash?: PageOptions["flash"];
  /** The form holds an unsaved edit from earlier rather than what is published. */
  draft?: boolean;
  /** The page the preview opens; defaults to the site's dev server root. */
  previewUrl?: string;
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
    ? region.allow.some((type) => hasRichText(schema.blocks[type]?.fields ?? {}))
    : hasRichText(region.fields);

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
          <code>${regionId}</code> — publishing writes one commit to <code>${site.path}</code>.
        </p>
      </div>

      <div class="split">
        <form
          method="POST"
          action="/sites/${site.id}/regions/${regionId}"
          enctype="multipart/form-data"
          data-editor-form
          id="editor-form"
        >
          <input type="hidden" name="headSha" value="${headSha}" />
          ${pendingMediaNotice(options.pendingMedia)}
          <div class="form-actions">
            <button type="submit" name="action" value="publish">Publish</button>
            <a class="button secondary" href="/sites/${site.id}">Back to site</a>
          </div>
          ${options.draft ? draftNotice(`/sites/${site.id}/regions/${regionId}/draft/discard`) : ""}
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
          <div class="tools" aria-label="Reorder or remove ${definition?.label ?? type}">
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

/** SQLite's `datetime('now')` is UTC without a zone marker; say so rather than let the browser guess. */
function when(stored: string) {
  const date = new Date(
    /[zZ]|[+-]\d\d:\d\d$/.test(stored) ? stored : `${stored.replace(" ", "T")}Z`,
  );
  if (Number.isNaN(date.getTime())) return html`${stored}`;
  const label = date.toLocaleString(locale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return html`<time datetime="${date.toISOString()}">${label} UTC</time>`;
}

function describeRegion(region: RegionDef): string {
  if (isBlocksRegion(region)) {
    return `block list (${region.allow.join(", ")})`;
  }
  const count = Object.keys(region.fields).length;
  return `${count} field${count === 1 ? "" : "s"}`;
}

export function inboxPage(options: {
  submissions: Submission[];
  sites: Site[];
  siteId?: string;
  includeSpam: boolean;
  flash?: PageOptions["flash"];
}): string {
  const { submissions, sites, siteId, includeSpam, flash } = options;
  const nameOf = (id: string) => sites.find((site) => site.id === id)?.name ?? id;
  const unread = submissions.filter((submission) => !submission.readAt).length;

  return page(
    {
      title: "Inbox",
      section: "inbox",
      unread,
      crumbs: [
        { href: "/", label: "Sites" },
        { href: "/inbox", label: "Inbox" },
      ],
      flash,
    },
    html`
      <div class="page-head">
        <div class="section-head">
          <h1>Inbox</h1>
          <a class="button secondary" href="/inbox.csv${siteId ? `?site=${siteId}` : ""}">
            Export as CSV
          </a>
        </div>
        <p class="lede">
          Form submissions from every connected site. Sites post a plain HTML form here — no
          JavaScript, no third-party form service.
        </p>
      </div>

      <form method="GET" action="/inbox" class="filter-bar">
        <div class="field">
          <label for="site">Site</label>
          <select id="site" name="site">
            <option value="">All sites</option>
            ${sites.map(
              (site) => html`
                <option value="${site.id}" ${site.id === siteId ? "selected" : ""}>
                  ${site.name}
                </option>
              `,
            )}
          </select>
        </div>
        <div class="field checkbox">
          <input type="checkbox" id="spam" name="spam" value="1" ${includeSpam ? "checked" : ""} />
          <label for="spam">Include suspected spam</label>
        </div>
        <button class="secondary" type="submit">Filter</button>
      </form>

      ${
        submissions.length === 0
          ? html`
              <div class="empty">
                <h2>Nothing here yet</h2>
                <p>
                  Each site's page has the address its forms post to, with a form ready to paste.
                  Submissions land here.
                </p>
              </div>
            `
          : html`
              <ul class="cards">
                ${submissions.map(
                  (submission) => html`
                    <li class="card submission ${submission.readAt ? "read" : "unread"}">
                      <div class="card-topline">
                        <h2>
                          ${submission.readAt ? "" : html`<span class="badge">New</span> `}
                          ${nameOf(submission.siteId)}
                          <span class="tag">${submission.form}</span>
                        </h2>
                        <span class="muted small">${when(submission.createdAt)}</span>
                      </div>
                      ${
                        submission.spamScore >= 3
                          ? html`<p class="spam-note">
                              <strong>Suspected spam:</strong> ${submission.spamReasons.join("; ")}
                            </p>`
                          : ""
                      }
                      <dl class="entry">
                        ${Object.entries(submission.data).map(
                          ([key, value]) => html`
                            <dt>${key}</dt>
                            <dd>${value}</dd>
                          `,
                        )}
                      </dl>
                      <div class="actions compact">
                        <form method="POST" action="/inbox/${submission.id}/read">
                          <input
                            type="hidden"
                            name="read"
                            value="${submission.readAt ? "0" : "1"}"
                          />
                          <button class="secondary" type="submit">
                            Mark as ${submission.readAt ? "unread" : "read"}
                          </button>
                        </form>
                        <details class="inline-confirm">
                          <summary>Delete</summary>
                          <form method="POST" action="/inbox/${submission.id}/delete">
                            <button class="danger" type="submit">Confirm delete</button>
                          </form>
                        </details>
                      </div>
                    </li>
                  `,
                )}
              </ul>
            `
      }
    `,
  );
}

export function collectionPage(options: {
  site: Site;
  schema: CmsSchema;
  name: string;
  label: string;
  entryLabel?: string;
  entries: Array<{ slug: string; title: string; summary?: string }>;
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
        <p class="lede">Stored in <code>${site.path}</code>. Each entry is a file.</p>
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
              <ul class="cards">
                ${entries.map(
                  (entry) => html`
                    <li class="card">
                      <h2>
                        <a
                          href="/sites/${site.id}/collections/${name}/${encodeURIComponent(entry.slug)}"
                          >${entry.title}</a
                        >
                      </h2>
                      <p>
                        <code>${entry.slug}</code>${entry.summary ? html` · ${entry.summary}` : ""}
                      </p>
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
  previewUrl?: string;
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
        { href: action, label: slug ?? "New entry" },
      ],
      flash,
      editor: hasRichText(fields, plain),
      liveSite: true,
    },
    html`
      <div class="page-head">
        <h1>${heading}</h1>
        <p class="lede">
          ${
            slug
              ? html`Editing ${entryLabel} <code>${slug}</code> in ${label}. The file name stays as
                  it is.`
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
          ${pendingMediaNotice(options.pendingMedia)}
          <div class="form-actions">
            <button type="submit" name="action" value="publish">Publish</button>
            <a class="button secondary" href="/sites/${site.id}/collections/${name}">Cancel</a>
          </div>
          ${options.draft && slug ? draftNotice(`${action}/draft/discard`) : ""}
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
