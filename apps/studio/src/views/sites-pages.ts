/** The list of sites and the form that adds one. */

import { html } from "hono/html";
import type { Site } from "../db.js";
import type { CmsSchema } from "@greatcms/spec";
import type { CloneState, Folder } from "../connect.js";
import type { BranchState } from "../repo.js";
import { siteNav } from "./editor-parts.js";
import { chrome } from "./chrome.js";
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
    : html`<a
        class="status ready open-site"
        href="${site.devUrl}"
        target="_blank"
        rel="noopener"
        title="Open ${site.devUrl} in a new tab"
        ><span class="status-text">Open site</span>${icon("external")}<span class="visually-hidden">
          at ${hostOf(site.devUrl)} (opens in a new tab)</span
        ></a
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
    fieldErrors?: { path?: string; devUrl?: string; deployRoot?: string; branch?: string };
    /** The branch the edited site's folder is on, and the remote's main one. */
    branch?: BranchState | null;
    /** Present when changing a connected site rather than connecting a new one. */
    editing?: Site;
    /** The edited site's schema, so the sidebar lists its content as on every other site page. */
    schema?: CmsSchema;
    /** The sites folder (`STUDIO_SITES_ROOT`) and what is in it, when one is set. */
    sitesRoot?: string;
    folders?: Folder[];
    clones?: CloneState[];
    /** `STUDIO_PREVIEW_URL`, so the dev URL field can say what an empty one becomes. */
    previewTemplate?: string;
    cloneValues?: Record<string, string>;
    cloneError?: string;
    /** Whether the Git access page exists, to point a private repository there. */
    gitAccess?: boolean;
    /** The repositories the GitHub App reaches, when GitHub can be connected. */
    github?: GitHubRepositories;
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
          branch: options.branch?.branch ?? "",
        }
      : {});
  const onDefault = Boolean(
    options.branch?.branch &&
    options.branch.branch === (options.branch.defaultBranch ?? "main") &&
    options.branch.remote,
  );
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
      refresh: options.clones?.some((clone) => clone.state === "cloning") ? 3 : undefined,
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

      ${editing ? "" : connectSources(options)}
      ${
        !editing && options.sitesRoot
          ? html`<h2 class="connect-heading" id="other">Another folder</h2>
              <p class="lede">Anywhere else on this machine, by its full path.</p>`
          : ""
      }

      <form method="POST" action="${action}" class="page-form">
        <div class="field">
          <label for="name">Name</label>
          <input
            type="text"
            id="name"
            name="name"
            value="${values.name ?? ""}"
            autocomplete="off"
            aria-describedby="name-hint"
            ${editing ? html`required` : ""}
          />
          <span class="hint" id="name-hint"
            >What you will call it in this
            studio.${editing ? "" : " Leave it empty to use the folder's name."}</span
          >
        </div>

        <div class="field">
          <label for="path">Folder path</label>
          <input
            type="text"
            id="path"
            name="path"
            value="${values.path ?? ""}"
            placeholder="${options.sitesRoot ? `${options.sitesRoot}/my-site` : "/home/you/projects/my-site"}"
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
            what you are
            typing.${
              !editing && options.previewTemplate
                ? html` Leave it empty to use this studio's preview service, at
                    <code>${options.previewTemplate.replace("{site}", "<name>")}</code>.`
                : ""
            }
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
                ${
                  options.branch
                    ? html`<div class="field">
                        <label for="branch">Branch</label>
                        <input
                          type="text"
                          id="branch"
                          name="branch"
                          value="${values.branch ?? ""}"
                          placeholder="greatcms-content"
                          autocomplete="off"
                          spellcheck="false"
                          aria-describedby="${describedBy("branch-hint", fieldErrors.branch)}"
                          ${fieldErrors.branch ? html`aria-invalid="true"` : ""}
                        />
                        <span class="hint" id="branch-hint">
                          Publishes are committed on this branch, and pushed to the branch of the
                          same
                          name${options.branch.remote ? html` on <code>${options.branch.remote}</code>` : ""}.
                          Type a new name to start a branch from this one, so the live site's branch
                          is left alone until you merge.
                        </span>
                        ${
                          fieldErrors.branch
                            ? html`<p class="error-text" id="branch-hint-error">
                                ${fieldErrors.branch}
                              </p>`
                            : ""
                        }
                      </div>`
                    : ""
                }
                ${
                  onDefault
                    ? html`<p class="notice warn" role="note">
                        This folder is on <code>${options.branch?.branch}</code>, the repository's
                        main branch. With pushing on, every publish goes wherever that branch
                        deploys, usually the live site.
                      </p>`
                    : ""
                }
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
                    anyone running Git. Signs in with this machine's Git
                    credentials${
                      chrome().local
                        ? ""
                        : html`, or the studio's own <a href="/git-access">Git access</a>`
                    };
                    hooks never run.
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
        editing && !chrome().local
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

/** The sites folder's contents and the Git form, above the path form, when a sites folder is set. */
function connectSources(options: Parameters<typeof newSitePage>[0]) {
  const {
    sitesRoot,
    folders = [],
    clones = [],
    cloneValues = {},
    cloneError,
    gitAccess,
    github,
  } = options ?? {};
  if (!sitesRoot) return "";
  const working = clones.filter((clone) => clone.state === "cloning");
  const failed = clones.filter((clone) => clone.state === "failed");
  return html`
    <section class="connect-section" aria-labelledby="found">
      <h2 id="found">In the sites folder</h2>
      <p>
        Folders in <code>${sitesRoot}</code>. Connect one, or set it up if it has no schema yet.
      </p>
      ${
        working.length || failed.length
          ? html`<ul class="folders" role="list" aria-live="polite">
              ${working.map(
                (clone) => html`<li>
                  <div>
                    <strong>${clone.folder}</strong>
                    <span class="muted">Copying from ${clone.url}…</span>
                  </div>
                </li>`,
              )}
              ${failed.map(
                (clone) => html`<li>
                  <div>
                    <strong>${clone.folder}</strong>
                    <span class="error-text"
                      >Not copied:
                      ${clone.state === "failed" ? clone.reason : ""}${
                        gitAccess && clone.state === "failed" && clone.reason.includes("sign-in")
                          ? html` <a href="/git-access">Set up Git access</a>.`
                          : ""
                      }</span
                    >
                  </div>
                  <form method="POST" action="/sites/clone/dismiss">
                    <input type="hidden" name="folder" value="${clone.folder}" />
                    <button class="secondary" type="submit">Dismiss</button>
                  </form>
                </li>`,
              )}
            </ul>`
          : ""
      }
      ${
        folders.length
          ? html`<ul class="folders" role="list">
              ${folders.map((folder) => folderRow(folder))}
            </ul>`
          : html`<p class="muted">Nothing here yet. Copy a site from Git below.</p>`
      }
    </section>

    ${github ? githubList(github) : ""}

    <section class="connect-section" aria-labelledby="clone">
      <h2 id="clone">Copy from Git</h2>
      <p>
        Clones a repository into the sites folder with this machine's Git access. Only the files are
        fetched: nothing from the repository runs.
      </p>
      <form method="POST" action="/sites/clone" class="card-form">
        <div class="field">
          <label for="clone-url">Repository address</label>
          <input
            type="text"
            id="clone-url"
            name="url"
            value="${cloneValues.url ?? ""}"
            placeholder="https://github.com/you/my-site.git"
            autocomplete="off"
            spellcheck="false"
            required
            aria-describedby="${describedBy("clone-url-hint", cloneError)}"
            ${cloneError ? html`aria-invalid="true"` : ""}
          />
          <span class="hint" id="clone-url-hint"
            >An https or SSH address.
            ${
              gitAccess
                ? html`For a private repository, first give the studio a key or token in
                    <a href="/git-access">Git access</a>.`
                : "A private repository needs a deploy key or token on this machine."
            }</span
          >
          ${cloneError ? html`<p class="error-text" id="clone-url-hint-error">${cloneError}</p>` : ""}
        </div>
        <div class="field">
          <label for="clone-branch">Branch <span class="tag">optional</span></label>
          <input
            type="text"
            id="clone-branch"
            name="branch"
            value="${cloneValues.branch ?? ""}"
            placeholder="main"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="clone-branch-hint"
          />
          <span class="hint" id="clone-branch-hint"
            >Empty for the repository's default branch.</span
          >
        </div>
        <div class="field">
          <label for="clone-folder">Folder name <span class="tag">optional</span></label>
          <input
            type="text"
            id="clone-folder"
            name="folder"
            value="${cloneValues.folder ?? ""}"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="clone-folder-hint"
          />
          <span class="hint" id="clone-folder-hint">Empty for the repository's own name.</span>
        </div>
        <div class="form-actions">
          <button type="submit">Copy</button>
        </div>
      </form>
    </section>
  `;
}

export interface GitHubRepositories {
  connected: boolean;
  installUrl?: string;
  error?: string;
  repositories?: Array<{
    fullName: string;
    cloneUrl: string;
    private: boolean;
    /** The folder it would be copied to; empty when that name is taken by another folder. */
    folder: string;
    state: Folder["state"] | null;
    siteId?: string;
  }>;
}

/** The repositories the GitHub App was given, each a click from being copied here. */
function githubList(github: GitHubRepositories) {
  if (!github.connected) {
    return html`<section class="connect-section" aria-labelledby="github">
      <h2 id="github">From GitHub</h2>
      <p>
        <a href="/git-access">Connect GitHub</a> to pick from your repositories, private ones
        included, instead of typing an address.
      </p>
    </section>`;
  }
  const repositories = github.repositories ?? [];
  return html`<section class="connect-section" aria-labelledby="github">
    <h2 id="github">From GitHub</h2>
    <p>
      The repositories this studio's GitHub App may use.
      ${
        github.installUrl
          ? html`Missing one? <a href="${github.installUrl}">Choose repositories on GitHub</a>.`
          : ""
      }
    </p>
    ${
      github.error
        ? html`<p class="error-text">${github.error}</p>`
        : repositories.length
          ? html`<ul class="folders" role="list">
              ${repositories.map(
                (repo) => html`<li>
                  <div>
                    <strong>${repo.fullName}</strong>
                    <span class="muted"
                      >${repo.private ? "Private" : "Public"}${
                        repo.state === "connected"
                          ? " · connected"
                          : repo.state
                            ? " · in the sites folder"
                            : ""
                      }</span
                    >
                  </div>
                  ${
                    repo.state === "connected"
                      ? html`<a class="button secondary" href="/sites/${repo.siteId}"
                          >Open<span class="visually-hidden"> ${repo.fullName}</span></a
                        >`
                      : repo.state
                        ? ""
                        : html`<form method="POST" action="/sites/clone">
                            <input type="hidden" name="url" value="${repo.cloneUrl}" />
                            ${
                              repo.folder
                                ? ""
                                : html`<input
                                    type="hidden"
                                    name="folder"
                                    value="${repo.fullName.replace("/", "-")}"
                                  />`
                            }
                            <button type="submit">
                              Copy<span class="visually-hidden"> ${repo.fullName}</span>
                            </button>
                          </form>`
                  }
                </li>`,
              )}
            </ul>`
          : html`<p class="muted">The app was not given any repositories yet.</p>`
    }
  </section>`;
}

function folderRow(folder: Folder) {
  const status = {
    connected: "Connected",
    ready: "Ready to connect",
    "needs-setup": "No .cms/schema.yaml yet",
  }[folder.state];
  return html`<li>
    <div>
      <strong>${folder.name}</strong>
      <span class="muted">${status}</span>
    </div>
    ${
      folder.state === "connected"
        ? html`<a class="button secondary" href="/sites/${folder.siteId}"
            >Open<span class="visually-hidden"> ${folder.name}</span></a
          >`
        : folder.state === "ready"
          ? html`<form method="POST" action="/sites">
              <input type="hidden" name="path" value="${folder.path}" />
              <button type="submit">
                Connect<span class="visually-hidden"> ${folder.name}</span>
              </button>
            </form>`
          : html`<a
              class="button secondary"
              href="/sites/setup?path=${encodeURIComponent(folder.path)}"
              >Set up<span class="visually-hidden"> ${folder.name}</span></a
            >`
    }
  </li>`;
}

/** For a folder with no schema: a starter from the same templates as `greatcms init`. */
export function setupPage(options: {
  path: string;
  values: Record<string, string>;
  templates: Array<{ id: string; label: string; hint: string }>;
  error?: string;
}): string {
  const { path, values, templates } = options;
  const chosen = values.template || "hero";
  return page(
    {
      title: "Set up a site",
      section: "sites",
      crumbs: [
        { href: "/", label: "Sites" },
        { href: "/sites/new", label: "Connect a site" },
        { href: `/sites/setup?path=${encodeURIComponent(path)}`, label: "Set up" },
      ],
      flash: options.error ? { kind: "error", message: options.error } : undefined,
    },
    html`
      <div class="page-head">
        <h1>Set up a site</h1>
        <p class="lede">
          <code>${path}</code> has no <code>.cms/schema.yaml</code> yet. Choose what the studio
          should manage to begin with. It writes <code>.cms/schema.yaml</code> and
          <code>.cms/config.yaml</code>, commits them, and connects the site. Nothing else in the
          folder changes; the pages read the content once they use <code>@greatcms/reader</code>.
        </p>
      </div>

      <form method="POST" action="/sites/setup" class="page-form">
        <input type="hidden" name="path" value="${path}" />
        <input type="hidden" name="devUrl" value="${values.devUrl ?? ""}" />
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
          <span class="hint">The site's name, written into the schema.</span>
        </div>
        <fieldset>
          <legend>Start with</legend>
          ${templates.map(
            (template) => html`<div class="choice">
              <input
                type="radio"
                id="template-${template.id}"
                name="template"
                value="${template.id}"
                aria-describedby="template-${template.id}-hint"
                ${template.id === chosen ? html`checked` : ""}
              />
              <div>
                <label for="template-${template.id}">${template.label}</label>
                <span class="hint" id="template-${template.id}-hint">${template.hint}</span>
              </div>
            </div>`,
          )}
        </fieldset>
        <div class="form-actions">
          <button type="submit">Set up and connect</button>
          <a class="button secondary" href="/sites/new">Cancel</a>
        </div>
      </form>
    `,
  );
}
