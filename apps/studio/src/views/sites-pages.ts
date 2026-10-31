/** The list of sites and the form that adds one. */

import { html } from "hono/html";
import type { Site } from "../db.js";
import type { CmsSchema } from "@greatcms/spec";
import { siteNav } from "./editor-parts.js";
import { page, type PageOptions } from "./layout.js";
import { icon } from "./icons.js";
import { siteAvatar } from "./pixel.js";

export function sitesPage(
  sites: Site[],
  unread = 0,
  flash?: PageOptions["flash"],
  running: ReadonlyMap<string, boolean | null> = new Map(),
): string {
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
                    <li class="card site-card">
                      ${siteAvatar(site.id)}
                      <div class="site-card-body">
                        <h2><a href="/sites/${site.id}">${site.name}</a></h2>
                        <p class="path" title="${site.path}">
                          <code>${shortPath(site.path)}</code>
                        </p>
                        ${previewStatus(site, running.get(site.id))}
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

/** Whether the site's preview can be seen now, and where. */
function previewStatus(site: Site, running: boolean | null | undefined) {
  if (!site.devUrl) return html`<span class="status idle">No live preview</span>`;
  return running === false
    ? html`<span class="status down" title="${hostOf(site.devUrl)}">Dev server not running</span>`
    : html`<span class="status ready" title="${site.devUrl}"
        ><span class="status-text">Running at ${hostOf(site.devUrl)}</span></span
      >`;
}

/** The last two folders of a path: enough to tell sites apart, short enough not to wrap. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A field's hint, plus its error when there is one, for aria-describedby. */
function describedBy(hint: string, error?: string): string {
  return error ? `${hint} ${hint}-error` : hint;
}

export function newSitePage(
  options: {
    error?: string;
    values?: Record<string, string>;
    fieldErrors?: { path?: string; devUrl?: string; deployRoot?: string };
    /** Present when changing a connected site rather than connecting a new one. */
    editing?: Site;
    /** The edited site's schema, so the sidebar lists its content as on every other site page. */
    schema?: CmsSchema;
  } = {},
): string {
  const { editing, fieldErrors = {} } = options;
  const values: Record<string, string> =
    options.values ??
    (editing
      ? {
          name: editing.name,
          path: editing.path,
          devUrl: editing.devUrl,
          deployRoot: editing.deployRoot,
        }
      : {});
  const title = editing ? "Site settings" : "Connect a site";
  const action = editing ? `/sites/${editing.id}/settings` : "/sites";

  return page(
    {
      title,
      section: "sites",
      site: editing && options.schema ? siteNav(editing, options.schema, "settings") : editing,
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
                  reads it to build the editor: it never runs any code from your site.`
          }
        </p>
      </div>

      <form method="POST" action="${action}" class="page-form">
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
            If set, the editor shows your real site beside the form: your own components, rendering
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
                  <label for="deployRoot">Builder folder <span class="tag">optional</span></label>
                  <input
                    type="text"
                    id="deployRoot"
                    name="deployRoot"
                    value="${values.deployRoot ?? ""}"
                    placeholder="/srv/www"
                    autocomplete="off"
                    spellcheck="false"
                    aria-describedby="${describedBy("deploy-hint", fieldErrors.deployRoot)}"
                    ${fieldErrors.deployRoot ? html`aria-invalid="true"` : ""}
                  />
                  <span class="hint" id="deploy-hint">
                    Where <code>greatcms-deploy</code> keeps its releases, as this studio sees it.
                    With it, the site page shows what is live and can roll back.
                  </span>
                  ${
                    fieldErrors.deployRoot
                      ? html`<p class="error-text" id="deploy-hint-error">
                          ${fieldErrors.deployRoot}
                        </p>`
                      : ""
                  }
                </div>
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
      ${
        editing
          ? html`<section class="danger-zone" aria-labelledby="danger">
              <h2 id="danger">Disconnect</h2>
              <p>
                Removes this site from the studio. Nothing is deleted from
                <code>${editing.path}</code>: its content and history stay in Git.
              </p>
              <details class="danger-confirm">
                <summary>Disconnect this site</summary>
                <p>
                  Its form submissions in the inbox and any scheduled publishes are deleted with the
                  connection.
                </p>
                <form method="POST" action="/sites/${editing.id}/delete">
                  <button class="danger" type="submit">Confirm disconnect ${editing.name}</button>
                </form>
              </details>
            </section>`
          : ""
      }
    `,
  );
}
