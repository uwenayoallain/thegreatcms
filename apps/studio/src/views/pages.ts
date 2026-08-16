import type { BlockDef, CmsSchema, CollectionFormat, FieldDef, RegionDef } from "@greatcms/spec";
import { isBlocksRegion } from "@greatcms/spec";
import { html } from "hono/html";
import type { Publish, Site, Submission } from "../db.js";
import type { UnsavedDraft } from "../sites.js";
import { fieldName } from "../form.js";
import { type ErrorsByPath, hasRichText, renderFields } from "./fields.js";
import { page, type PageOptions } from "./layout.js";

export function signInPage(options: { error?: string } = {}): string {
  return page(
    {
      title: "Sign in",
      chrome: false,
      flash: options.error ? { kind: "error", message: options.error } : undefined,
    },
    html`
      <div class="page-head">
        <h1>GreatCMS Studio</h1>
        <p class="lede">Sign in to edit your sites.</p>
      </div>
      <form method="POST" action="/sign-in">
        <div class="field">
          <label for="password">Password</label>
          <input
            type="password"
            id="password"
            name="password"
            autocomplete="current-password"
            required
            autofocus
          />
        </div>
        <div class="actions"><button type="submit">Sign in</button></div>
      </form>
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
          ${sites.length > 0 ? html`<a class="button" href="/sites/new">Connect a site</a>` : ""}
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
                      <h2><a href="/sites/${site.id}">${site.name}</a></h2>
                      <p><code>${site.path}</code></p>
                    </li>
                  `,
                )}
              </ul>
            `
      }
    `,
  );
}

export function newSitePage(
  options: { error?: string; values?: Record<string, string> } = {},
): string {
  const values = options.values ?? {};

  return page(
    {
      title: "Connect a site",
      section: "sites",
      crumbs: [
        { href: "/", label: "Sites" },
        { href: "/sites/new", label: "Connect a site" },
      ],
      flash: options.error ? { kind: "error", message: options.error } : undefined,
    },
    html`
      <div class="page-head">
        <h1>Connect a site</h1>
        <p class="lede">
          A folder on this machine containing a <code>.cms/schema.yaml</code>. The studio reads it
          to build the editor — it never runs any code from your site.
        </p>
      </div>

      <form method="POST" action="/sites">
        <div class="field">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" value="${values.name ?? ""}" required />
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
            aria-describedby="path-hint"
            required
          />
          <span class="hint" id="path-hint">
            The directory containing <code>.cms/schema.yaml</code>. Publishing writes the files and
            commits them if it is a Git repository.
          </span>
        </div>

        <div class="field">
          <label for="devUrl">Dev server URL <span class="tag">optional</span></label>
          <input
            type="text"
            id="devUrl"
            name="devUrl"
            value="${values.devUrl ?? ""}"
            placeholder="http://localhost:4321"
            aria-describedby="dev-hint"
          />
          <span class="hint" id="dev-hint">
            If set, the editor shows your real site beside the form — your own components, rendering
            what you are typing.
          </span>
        </div>

        <div class="form-actions">
          <button type="submit">Connect</button>
          <a class="button secondary" href="/">Cancel</a>
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
): string {
  const regions = Object.entries(schema.regions);
  const collections = Object.entries(schema.collections);

  return page(
    {
      title: site.name,
      section: "sites",
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
      ],
      flash,
    },
    html`
      <div class="page-head">
        <h1>${site.name}</h1>
        <p class="lede"><code>${site.path}</code> · publishing writes the files and commits them</p>
      </div>

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

      <h2>Regions</h2>
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

      ${
        collections.length > 0
          ? html`
              <h2>Collections</h2>
              <ul class="cards two">
                ${collections.map(
                  ([name, collection]) => html`
                    <li class="card">
                      <h3>
                        <a href="/sites/${site.id}/collections/${name}">
                          ${collection.label ?? name}
                        </a>
                      </h3>
                      <p><code>${collection.path}</code> · ${collection.format}</p>
                    </li>
                  `,
                )}
              </ul>
            `
          : ""
      }
      ${
        publishes.length > 0
          ? html`
              <h2>Recent publishes</h2>
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
                        <td>${entry.created_at}</td>
                        <td>
                          <code>${entry.commit_sha.slice(0, 7)}</code>
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `
          : ""
      }

      <section class="danger-zone" aria-labelledby="danger">
        <h2 id="danger">Danger zone</h2>
        <p>Disconnects this site from the studio. Nothing is deleted from ${site.path}.</p>
        <form method="POST" action="/sites/${site.id}/delete">
          <button class="danger" type="submit">Disconnect ${site.name}</button>
        </form>
      </section>
    `,
  );
}

export interface EditPageOptions {
  site: Site;
  schema: CmsSchema;
  regionId: string;
  region: RegionDef;
  document: Record<string, unknown>;
  errors: ErrorsByPath;
  headSha: string;
  flash?: PageOptions["flash"];
  preview?: { url: string | null; branch: string };
}

export function editRegionPage(options: EditPageOptions): string {
  const { site, schema, regionId, region, document, errors, headSha, flash, preview } = options;
  const title = region.label ?? regionId;

  const editor = isBlocksRegion(region)
    ? region.allow.some((type) => hasRichText(schema.blocks[type]?.fields ?? {}))
    : hasRichText(region.fields);

  return page(
    {
      title,
      section: "sites",
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

          ${
            isBlocksRegion(region)
              ? renderBlocks(schema, region, document, errors)
              : renderFields(region.fields, document, errors, [], { blocks: schema.blocks })
          }

          <div class="form-actions">
            <button type="submit" name="action" value="publish">Publish</button>
            <a class="button secondary" href="/sites/${site.id}">Back to site</a>
          </div>
        </form>

        <aside class="live" aria-labelledby="live-heading">
          <div class="live-bar">
            <h2 id="live-heading">Your site</h2>
            <p class="muted" id="live-status" role="status">
              ${site.devUrl || "No dev server connected"}
            </p>
          </div>
          ${
            site.devUrl
              ? html`
                  <iframe
                    title="Your site, running locally"
                    class="live-frame real"
                    src="${site.devUrl}"
                    data-live-site="/sites/${site.id}/regions/${regionId}/draft"
                  ></iframe>
                  <p class="hint">
                    Your real components, rendering what is in the form. Edits are written to
                    <code>.cms/draft/</code> for your dev server to read — never committed until you
                    publish.
                  </p>
                  <div class="live-actions">
                    <form
                      method="POST"
                      action="/sites/${site.id}/regions/${regionId}/draft/discard"
                    >
                      <button class="secondary" type="submit">Discard unsaved edits</button>
                    </form>
                    <button class="secondary" type="button" data-live-reload hidden>
                      Reload the site
                    </button>
                  </div>
                `
              : html`
                  <p class="hint">
                    Connect this site as a folder on this machine and give it your dev server's URL,
                    and your edits will render here in your own components as you type.
                  </p>
                `
          }
        </aside>
      </div>

      ${
        preview
          ? html`
              <h2>Preview</h2>
              <p>
                Saved to <code>${preview.branch}</code>. Your own pipeline builds it — exactly the
                real site, because it is the real build.
              </p>
              ${
                preview.url
                  ? html`
                      <p><a href="${preview.url}">Open the preview</a></p>
                      <iframe
                        src="${preview.url}"
                        title="Preview of ${regionId} on branch ${preview.branch}"
                        class="preview"
                        loading="lazy"
                      ></iframe>
                    `
                  : html`<p class="muted">
                      Set <code>preview.urlTemplate</code> in <code>.cms/config.yaml</code> — for
                      example <code>https://{branch}--site.pages.dev</code> — to see your CI's build
                      inline here.
                    </p>`
              }

              <h3>Or preview it locally, right now</h3>
              <p>
                Run this in your checkout. It overlays this draft onto your working copy, starts
                your own dev server, and puts everything back when you stop it.
              </p>
              <pre><code>npx greatcms preview --branch ${preview.branch} --run "npm run dev"</code></pre>
              <p class="muted">
                Your build runs on your machine, with your toolchain. The studio never executes
                anything from your repository.
              </p>
            `
          : ""
      }
    `,
  );
}

function renderBlocks(
  schema: CmsSchema,
  region: Extract<RegionDef, { type: "blocks" }>,
  document: Record<string, unknown>,
  errors: ErrorsByPath,
) {
  const blocks = Array.isArray(document.blocks)
    ? (document.blocks as Array<Record<string, unknown>>)
    : [];

  return html`
    ${blocks.map((block, index) => {
      const type = String(block._type ?? "");
      const definition = schema.blocks[type];
      const name = fieldName(["blocks", index, "_type"]);
      return html`
        <section class="block" aria-label="${definition?.label ?? type} (position ${index + 1})">
          <header>
            <h2>${definition?.label ?? type}</h2>
            <div class="tools">
              <button
                type="submit"
                name="action"
                value="up:${index}"
                ${index === 0 ? "disabled" : ""}
              >
                Move up<span class="visually-hidden"> ${definition?.label ?? type}</span>
              </button>
              <button
                type="submit"
                name="action"
                value="down:${index}"
                ${index === blocks.length - 1 ? "disabled" : ""}
              >
                Move down<span class="visually-hidden"> ${definition?.label ?? type}</span>
              </button>
              <button type="submit" name="action" value="remove:${index}">
                Remove<span class="visually-hidden"> ${definition?.label ?? type}</span>
              </button>
            </div>
          </header>
          <input type="hidden" name="${name}" value="${type}" />
          ${
            definition
              ? renderFields(definition.fields, block, errors, ["blocks", index], {
                  blocks: schema.blocks,
                })
              : html`<p class="error-text">
                  This block type is no longer in the schema. Publishing will drop it.
                </p>`
          }
        </section>
      `;
    })}

    <div class="add-block">
      <div class="field">
        <label for="add-block">Add a block</label>
        <select id="add-block" name="addType">
          ${region.allow.map(
            (type) => html`<option value="${type}">${schema.blocks[type]?.label ?? type}</option>`,
          )}
        </select>
      </div>
      <button class="secondary" type="submit" name="action" value="add">Add block</button>
    </div>
  `;
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

      <form method="GET" action="/inbox" class="row">
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
        <div class="field">
          <button class="secondary" type="submit">Filter</button>
        </div>
      </form>

      ${
        submissions.length === 0
          ? html`
              <div class="empty">
                <h2>Nothing here yet</h2>
                <p>
                  Point a form at <code>/f/&lt;site&gt;/&lt;form&gt;</code> on this studio and the
                  submissions land here.
                </p>
              </div>
            `
          : html`
              <ul class="cards">
                ${submissions.map(
                  (submission) => html`
                    <li class="card">
                      <h2>
                        ${submission.readAt ? "" : html`<span class="badge">New</span> `}
                        ${nameOf(submission.siteId)} — ${submission.form}
                      </h2>
                      <p>
                        <time datetime="${submission.createdAt}">${submission.createdAt}</time>
                        ${
                          submission.spamScore >= 3
                            ? html` · <strong>suspected spam</strong>:
                                ${submission.spamReasons.join("; ")}`
                            : ""
                        }
                      </p>
                      <dl class="entry">
                        ${Object.entries(submission.data).map(
                          ([key, value]) => html`
                            <dt>${key}</dt>
                            <dd>${value}</dd>
                          `,
                        )}
                      </dl>
                      <div class="actions">
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
                        <form method="POST" action="/inbox/${submission.id}/delete">
                          <button class="danger" type="submit">Delete</button>
                        </form>
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
  name: string;
  label: string;
  entries: Array<{ slug: string; title: string; summary?: string }>;
  flash?: PageOptions["flash"];
}): string {
  const { site, name, label, entries, flash } = options;

  return page(
    {
      title: label,
      section: "sites",
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
                  New entry
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
                <h2>No entries yet</h2>
                <p>The first entry becomes a file in your repository when you publish it.</p>
                <a class="button" href="/sites/${site.id}/collections/${name}/new">
                  Write the first one
                </a>
              </div>
            `
          : html`
              <ul class="cards">
                ${entries.map(
                  (entry) => html`
                    <li class="card">
                      <h2>
                        <a href="/sites/${site.id}/collections/${name}/${entry.slug}"
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
        <a class="button secondary" href="/sites/${site.id}">Back to site</a>
      </div>
    `,
  );
}

export function editEntryPage(options: {
  site: Site;
  name: string;
  label: string;
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
}): string {
  const { site, name, label, slug, fields, document, errors, headSha, flash } = options;
  // MDX bodies are edited as source: the JSX in them is not HTML to round trip.
  const plain =
    options.format === "mdx" && options.body ? new Set([options.body]) : new Set<string>();
  const title = slug ? `${label}: ${slug}` : `New ${label} entry`;
  const action = `/sites/${site.id}/collections/${name}/${slug ?? "new"}`;

  return page(
    {
      title,
      section: "sites",
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
        <h1>${slug ?? `New ${label} entry`}</h1>
        <p class="lede">
          ${
            slug
              ? html`Editing an existing entry. The file name stays <code>${slug}</code>.`
              : html`The file name is derived from this entry's title when you save it.`
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
          ${renderFields(fields, document, errors, [], { plain, blocks: options.blocks })}

          <div class="form-actions">
            <button type="submit" name="action" value="publish">Publish</button>
            <a class="button secondary" href="/sites/${site.id}/collections/${name}">Cancel</a>
          </div>
        </form>

        <aside class="live" aria-labelledby="live-heading">
          <div class="live-bar">
            <h2 id="live-heading">Your site</h2>
            <p class="muted" id="live-status" role="status">
              ${site.devUrl || "No dev server connected"}
            </p>
          </div>
          ${
            site.devUrl && slug
              ? html`
                  <iframe
                    title="Your site, running locally"
                    class="live-frame real"
                    src="${site.devUrl}"
                    data-live-site="${action}/draft"
                  ></iframe>
                  <p class="hint">
                    Your real components, rendering what is in the form. Edits are written to
                    <code>.cms/draft/</code> for your dev server to read — never committed until you
                    publish.
                  </p>
                  <div class="live-actions">
                    <form method="POST" action="${action}/draft/discard">
                      <button class="secondary" type="submit">Discard unsaved edits</button>
                    </form>
                    <button class="secondary" type="button" data-live-reload hidden>
                      Reload the site
                    </button>
                  </div>
                `
              : html`
                  <p class="hint">
                    ${
                      slug
                        ? "Connect this site as a folder on this machine and give it your dev server's URL to see this entry render as you type."
                        : "A new entry renders here once it has been published, since your site has no file to read yet."
                    }
                  </p>
                `
          }
        </aside>
      </div>

      ${
        slug
          ? html`
              <section class="danger-zone" aria-labelledby="delete">
                <h2 id="delete">Delete</h2>
                <p>Removes <code>${slug}</code> from the repository in one commit.</p>
                <form method="POST" action="${action}/delete">
                  <button class="danger" type="submit">Delete this entry</button>
                </form>
              </section>
            `
          : ""
      }
    `,
  );
}
