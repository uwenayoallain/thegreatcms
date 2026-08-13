import type { CmsSchema, FieldDef, RegionDef } from "@greatcms/spec";
import { isBlocksRegion } from "@greatcms/spec";
import { html } from "hono/html";
import type { Publish, Site, Submission } from "../db.js";
import { fieldName } from "../form.js";
import { type ErrorsByPath, hasRichText, renderFields } from "./fields.js";
import { page, type PageOptions } from "./layout.js";

export function signInPage(options: { error?: string } = {}): string {
  return page(
    {
      title: "Sign in",
      flash: options.error ? { kind: "error", message: options.error } : undefined,
    },
    html`
      <h1>Sign in</h1>
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
    { title: "Sites", flash },
    html`
      <h1>Sites</h1>
      ${
        sites.length === 0
          ? html`<p class="muted">
              No sites yet. Connect a repository that contains a
              <code>.cms/schema.yaml</code> file.
            </p>`
          : html`
              <ul class="cards">
                ${sites.map(
                  (site) => html`
                    <li class="card">
                      <h2><a href="/sites/${site.id}">${site.name}</a></h2>
                      <p><code>${site.owner}/${site.repo}</code> · ${site.branch}</p>
                    </li>
                  `,
                )}
              </ul>
            `
      }
      <div class="actions">
        <a class="button" href="/sites/new">Connect a site</a>
        <a class="button secondary" href="/inbox">
          Inbox${unread > 0 ? html` (${unread} unread)` : ""}
        </a>
      </div>
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
      crumbs: [
        { href: "/", label: "Sites" },
        { href: "/sites/new", label: "Connect a site" },
      ],
      flash: options.error ? { kind: "error", message: options.error } : undefined,
    },
    html`
      <h1>Connect a site</h1>
      <p class="muted">
        The repository needs a <code>.cms/schema.yaml</code> file. The studio reads it to build the
        editor — it never runs any code from your repository.
      </p>
      <form method="POST" action="/sites">
        <div class="field">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" value="${values.name ?? ""}" required />
        </div>

        <fieldset class="field">
          <legend>Where does this site live?</legend>
          <div class="checkbox">
            <input type="radio" id="kind-local" name="kind" value="local" checked />
            <label for="kind-local">
              A folder on this machine
              <span class="hint">
                Reads and writes the working copy directly. No token, no network, and your dev
                server shows the change immediately.
              </span>
            </label>
          </div>
          <div class="checkbox">
            <input type="radio" id="kind-github" name="kind" value="github" />
            <label for="kind-github">
              A GitHub repository
              <span class="hint"
                >Publishing commits over the API and your pipeline deploys it.</span
              >
            </label>
          </div>
        </fieldset>

        <div class="field">
          <label for="path">Folder path</label>
          <input
            type="text"
            id="path"
            name="path"
            value="${values.path ?? ""}"
            placeholder="/home/you/projects/my-site"
            aria-describedby="path-hint"
          />
          <span class="hint" id="path-hint">
            The directory containing <code>.cms/schema.yaml</code>. Publishing writes the files and
            commits them if it is a Git repository.
          </span>
        </div>

        <div class="field">
          <label for="devUrl">Dev server URL <span class="hint">optional</span></label>
          <input
            type="text"
            id="devUrl"
            name="devUrl"
            value="${values.devUrl ?? ""}"
            placeholder="http://localhost:4321"
            aria-describedby="dev-hint"
          />
          <span class="hint" id="dev-hint">
            If set, the editor shows your real site here — your own components, updating when you
            publish.
          </span>
        </div>
        <div class="row">
          <div class="field">
            <label for="owner">Owner</label>
            <input type="text" id="owner" name="owner" value="${values.owner ?? ""}" required />
          </div>
          <div class="field">
            <label for="repo">Repository</label>
            <input type="text" id="repo" name="repo" value="${values.repo ?? ""}" required />
          </div>
          <div class="field">
            <label for="branch">Branch</label>
            <input
              type="text"
              id="branch"
              name="branch"
              value="${values.branch ?? "main"}"
              required
            />
          </div>
        </div>
        <div class="field">
          <label for="token">Access token</label>
          <input
            type="password"
            id="token"
            name="token"
            autocomplete="off"
            required
            aria-describedby="token-hint"
          />
          <span class="hint" id="token-hint">
            Needs <code>contents: write</code> on this repository only. Stored on this server.
          </span>
        </div>
        <fieldset class="field">
          <legend>How should publishing work?</legend>
          <div class="checkbox">
            <input type="radio" id="mode-direct" name="publishMode" value="direct" checked />
            <label for="mode-direct">
              Commit straight to the branch
              <span class="hint"
                >Fastest. Publishing is a commit, and your pipeline deploys it.</span
              >
            </label>
          </div>
          <div class="checkbox">
            <input type="radio" id="mode-pr" name="publishMode" value="pull-request" />
            <label for="mode-pr">
              Open a pull request
              <span class="hint">
                Review before it goes live, a CI preview build per change, and revert-to-roll-back.
              </span>
            </label>
          </div>
        </fieldset>

        <div class="field checkbox">
          <input type="checkbox" id="aiTitles" name="aiTitles" value="yes" />
          <label for="aiTitles">
            Let the configured model name pull requests
            <span class="hint">
              Sends the changed field names and values to that provider. Off by default; without it,
              titles are generated from the diff.
            </span>
          </label>
        </div>

        <div class="actions">
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
): string {
  const regions = Object.entries(schema.regions);
  return page(
    {
      title: site.name,
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
      ],
      flash,
    },
    html`
      <h1>${site.name}</h1>
      <p class="muted">
        ${
          site.kind === "local"
            ? html`<code>${site.path}</code>`
            : html`<code>${site.owner}/${site.repo}</code>`
        }
        ·
        ${
          site.publishMode === "pull-request"
            ? html`proposing changes as pull requests against ${site.branch}`
            : html`publishing straight to ${site.branch}`
        }
      </p>

      <h2>Regions</h2>
      <ul class="cards">
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
        Object.keys(schema.collections).length > 0
          ? html`
              <h2>Collections</h2>
              <ul class="cards">
                ${Object.entries(schema.collections).map(
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
                          <a href="${entry.commit_url}">${entry.commit_sha.slice(0, 7)}</a>
                          ${
                            entry.pull_request_url
                              ? html` · <a href="${entry.pull_request_url}">pull request</a>`
                              : ""
                          }
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `
          : ""
      }

      <h2>Danger zone</h2>
      <form method="POST" action="/sites/${site.id}/delete">
        <p class="muted">
          Disconnects this site from the studio. Nothing is deleted from the repository.
        </p>
        <button class="danger" type="submit">Disconnect ${site.name}</button>
      </form>
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
  pullRequest?: { number: number; url: string; title: string; fromModel: boolean };
}

export function editRegionPage(options: EditPageOptions): string {
  const { site, schema, regionId, region, document, errors, headSha, flash, preview, pullRequest } =
    options;
  const title = region.label ?? regionId;

  const editor = isBlocksRegion(region)
    ? region.allow.some((type) => hasRichText(schema.blocks[type]?.fields ?? {}))
    : hasRichText(region.fields);

  return page(
    {
      title,
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
        { href: `/sites/${site.id}/regions/${regionId}`, label: title },
      ],
      flash,
      editor,
      livePreview: true,
    },
    html`
      <h1>${title}</h1>
      <p class="muted">
        <code>${regionId}</code> — publishing writes one commit to
        <code>${site.owner}/${site.repo}</code> on ${site.branch}.
      </p>

      ${
        pullRequest
          ? html`
              <section class="card" aria-labelledby="pr">
                <h2 id="pr">Pull request #${pullRequest.number}</h2>
                <p>
                  <a href="${pullRequest.url}">${pullRequest.title}</a>
                </p>
                <p class="muted">
                  ${
                    pullRequest.fromModel
                      ? "Title written by the configured model; the change list below it is generated from the diff."
                      : "Title generated from the diff — no model involved."
                  }
                  Nothing reaches ${site.branch} until this is merged.
                </p>
              </section>
            `
          : ""
      }

      <div class="split">
        <form
          method="POST"
          action="/sites/${site.id}/regions/${regionId}"
          enctype="multipart/form-data"
          data-editor-form
          id="preview-form"
        >
          <input type="hidden" name="headSha" value="${headSha}" />

          ${
            isBlocksRegion(region)
              ? renderBlocks(schema, region, document, errors)
              : renderFields(region.fields, document, errors)
          }

          <div class="actions">
            <button type="submit" name="action" value="publish">
              ${site.publishMode === "pull-request" ? "Propose change" : "Publish"}
            </button>
            <button class="secondary" type="submit" name="action" value="draft">
              Save draft &amp; preview
            </button>
            <a class="button secondary" href="/sites/${site.id}">Back to site</a>
          </div>
        </form>

        <aside class="live" aria-labelledby="live-heading">
          ${
            site.kind === "local" && site.devUrl
              ? html`
                  <div class="live-bar">
                    <h2>Your site</h2>
                    <p class="muted"><code>${site.devUrl}</code></p>
                  </div>
                  <iframe
                    title="Your site, running locally"
                    class="live-frame real"
                    src="${site.devUrl}"
                  ></iframe>
                  <p class="hint">
                    Your real components, from your own dev server. Publishing writes files to
                    <code>${site.path}</code>, so this updates as soon as your dev server reloads.
                  </p>
                `
              : ""
          }

          <div class="live-bar">
            <h2 id="live-heading">
              ${site.kind === "local" && site.devUrl ? "Unsaved content" : "Live preview"}
            </h2>
            <p class="muted" id="preview-status" role="status">Not yet rendered</p>
          </div>
          <iframe
            title="Live preview of ${title}"
            class="live-frame"
            sandbox=""
            data-live-preview="/sites/${site.id}/regions/${regionId}/preview"
          ></iframe>
          <p class="hint">
            Your unsaved content, in the shape the schema describes. The layout is the studio's —
            for your real design, save a draft or run <code>greatcms preview</code>.
          </p>
          <p data-preview-fallback>
            <button
              class="secondary"
              type="submit"
              form="preview-form"
              formaction="/sites/${site.id}/regions/${regionId}/preview"
              formmethod="POST"
              formtarget="_blank"
            >
              Render preview
            </button>
          </p>
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
              ? renderFields(definition.fields, block, errors, ["blocks", index])
              : html`<p class="error-text">
                  This block type is no longer in the schema. Publishing will drop it.
                </p>`
          }
        </section>
      `;
    })}

    <div class="field">
      <label for="add-block">Add a block</label>
      <select id="add-block" name="addType">
        ${region.allow.map(
          (type) => html`<option value="${type}">${schema.blocks[type]?.label ?? type}</option>`,
        )}
      </select>
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

  return page(
    {
      title: "Inbox",
      crumbs: [
        { href: "/", label: "Sites" },
        { href: "/inbox", label: "Inbox" },
      ],
      flash,
    },
    html`
      <h1>Inbox</h1>
      <p class="muted">
        Form submissions from every connected site. Sites post a plain HTML form here — no
        JavaScript, no third-party form service.
      </p>

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
          ? html`<p class="muted">Nothing here yet.</p>`
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

      <div class="actions">
        <a class="button secondary" href="/inbox.csv${siteId ? `?site=${siteId}` : ""}">
          Export as CSV
        </a>
      </div>
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
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
        { href: `/sites/${site.id}/collections/${name}`, label },
      ],
      flash,
    },
    html`
      <h1>${label}</h1>
      <p class="muted">
        Stored as Markdown in <code>${site.owner}/${site.repo}</code>. Each entry is a file.
      </p>

      ${
        entries.length === 0
          ? html`<p class="muted">No entries yet.</p>`
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
        <a class="button" href="/sites/${site.id}/collections/${name}/new">New entry</a>
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
  document: Record<string, unknown>;
  errors: ErrorsByPath;
  headSha: string;
  flash?: PageOptions["flash"];
  pullRequest?: { number: number; url: string; title: string; fromModel: boolean };
}): string {
  const { site, name, label, slug, fields, document, errors, headSha, flash, pullRequest } =
    options;
  const title = slug ? `${label}: ${slug}` : `New ${label} entry`;
  const action = `/sites/${site.id}/collections/${name}/${slug ?? "new"}`;

  return page(
    {
      title,
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
        { href: `/sites/${site.id}/collections/${name}`, label },
        { href: action, label: slug ?? "New entry" },
      ],
      flash,
      editor: hasRichText(fields),
      livePreview: true,
    },
    html`
      <h1>${slug ?? `New ${label} entry`}</h1>
      <p class="muted">
        ${
          slug
            ? html`Editing an existing entry. The file name stays <code>${slug}</code>.`
            : html`The file name is derived from this entry's title when you save it.`
        }
      </p>

      ${
        pullRequest
          ? html`
              <section class="card" aria-labelledby="pr">
                <h2 id="pr">Pull request #${pullRequest.number}</h2>
                <p><a href="${pullRequest.url}">${pullRequest.title}</a></p>
              </section>
            `
          : ""
      }

      <div class="split">
        <form
          method="POST"
          action="${action}"
          enctype="multipart/form-data"
          data-editor-form
          id="preview-form"
        >
          <input type="hidden" name="headSha" value="${headSha}" />
          ${renderFields(fields, document, errors)}

          <div class="actions">
            <button type="submit" name="action" value="publish">
              ${site.publishMode === "pull-request" ? "Propose change" : "Publish"}
            </button>
            <a class="button secondary" href="/sites/${site.id}/collections/${name}">Cancel</a>
          </div>
        </form>

        <aside class="live" aria-labelledby="live-heading">
          ${
            site.kind === "local" && site.devUrl
              ? html`
                  <div class="live-bar">
                    <h2>Your site</h2>
                    <p class="muted"><code>${site.devUrl}</code></p>
                  </div>
                  <iframe
                    title="Your site, running locally"
                    class="live-frame real"
                    src="${site.devUrl}"
                  ></iframe>
                  <p class="hint">
                    Your real components, from your own dev server. Publishing writes files to
                    <code>${site.path}</code>, so this updates as soon as your dev server reloads.
                  </p>
                `
              : ""
          }

          <div class="live-bar">
            <h2 id="live-heading">
              ${site.kind === "local" && site.devUrl ? "Unsaved content" : "Live preview"}
            </h2>
            <p class="muted" id="preview-status" role="status">Not yet rendered</p>
          </div>
          <iframe
            title="Live preview of this entry"
            class="live-frame"
            sandbox=""
            data-live-preview="${action}/preview"
          ></iframe>
          <p class="hint">Your unsaved content, updating as you type. Nothing is committed.</p>
          <p data-preview-fallback>
            <button
              class="secondary"
              type="submit"
              form="preview-form"
              formaction="${action}/preview"
              formmethod="POST"
              formtarget="_blank"
            >
              Render preview
            </button>
          </p>
        </aside>
      </div>

      ${
        slug
          ? html`
              <h2>Delete</h2>
              <form method="POST" action="${action}/delete">
                <p class="muted">Removes <code>${slug}</code> from the repository in one commit.</p>
                <button class="danger" type="submit">Delete this entry</button>
              </form>
            `
          : ""
      }
    `,
  );
}
