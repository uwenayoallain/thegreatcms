/** A site's own home: its regions, collections, publishes and live site. */

import { ago, when } from "./locale.js";
import type { CmsSchema } from "@greatcms/spec";
import { html } from "hono/html";
import type { Scheduled, Site } from "../db.js";
import { formatInZone } from "../schedule.js";
import type { LiveSite } from "../deploys.js";
import type { BranchState, SyncState } from "../repo.js";
import { highlightHtml } from "./code.js";
import type { Activity, ContentChange, UnsavedDraft } from "../sites.js";
import { page, type PageOptions } from "./layout.js";
import { icon } from "./icons.js";
import { siteNav } from "./editor-parts.js";
import { siteAvatar } from "./pixel.js";
import { hostOf, shortPath } from "./sites-pages.js";
import { describeRegion } from "./region-page.js";
import { plural } from "./collection-pages.js";
import { viewer } from "./viewer.js";
import { withoutServerPaths } from "../redact.js";

/** Publishes waiting for their time, and how the last week's went. */
function scheduledPanel(site: Site, jobs: Scheduled[], timeZone: string, owner = "Owner") {
  const STATE = {
    waiting: "Waiting",
    running: "Publishing",
    published: "Published",
    failed: "Not published",
    cancelled: "Cancelled",
  } as const;
  return html`
    <section class="resource-section scheduled" id="scheduled" aria-labelledby="scheduled-heading">
      <div class="resource-heading">
        <h2 id="scheduled-heading">${icon("clock")} Scheduled</h2>
        <span>times in ${timeZone}</span>
      </div>
      <ul role="list">
        ${jobs.map(
          (job) => html`<li class="is-${job.status}">
            <div>
              <a href="/sites/${site.id}/${job.target}"><strong>${job.label}</strong></a>
              <span class="muted"
                >${STATE[job.status]} · ${formatInZone(job.dueAt, timeZone)} ·
                ${job.author?.name ?? owner}</span
              >
              ${job.detail && job.status === "failed" ? html`<span class="error-text">${job.detail}</span>` : ""}
            </div>
            ${
              job.status === "waiting"
                ? html`<form method="POST" action="/sites/${site.id}/scheduled/${job.id}/cancel">
                    <button class="secondary" type="submit">Cancel</button>
                  </form>`
                : ""
            }
          </li>`,
        )}
      </ul>
    </section>
  `;
}

/** What the builder has live, what it could not build, and the releases a rollback can return to. */
function livePanelFor(site: Site, live: LiveSite) {
  const current = live.live?.sha;
  // A build log names the builder's folders, which are the owner's to know.
  const log =
    !live.failed || viewer()?.owner !== false
      ? live.failed?.log
      : withoutServerPaths(live.failed.log, [site.path, site.deployRoot]);
  const older = live.releases.filter((release) => release.sha !== current);
  return html`
    <section class="resource-section live-site" id="live" aria-labelledby="live-site-heading">
      <div class="resource-heading">
        <h2 id="live-site-heading">${icon("rocket")} Live site</h2>
        ${live.checkedAt ? html`<span>checked ${when(live.checkedAt)}</span>` : ""}
      </div>
      ${
        live.live
          ? html`<p>
              <strong>${live.live.message}</strong>
              <span class="muted"
                >· <code>${live.live.sha.slice(0, 7)}</code> · live since
                ${when(live.live.at)}</span
              >
            </p>`
          : html`<p class="muted">Nothing has been built yet.</p>`
      }
      ${
        live.pinned
          ? html`<p class="live-note">
              Rolled back by hand. It stays like this until the next publish, which goes live as
              usual.
            </p>`
          : ""
      }
      ${
        live.requested
          ? html`<p class="live-note">
              Rolling back to <code>${live.requested.slice(0, 7)}</code>; the builder picks it up
              within seconds.
            </p>`
          : ""
      }
      ${
        live.failed
          ? html`<details class="live-failed">
              <summary>
                <strong>The last publish did not build:</strong> ${live.failed.message}
                (<code>${live.failed.sha.slice(0, 7)}</code>). The site above stays live.
              </summary>
              <pre><code>${log}</code></pre>
            </details>`
          : ""
      }
      ${
        older.length > 0
          ? html`<details class="inline-confirm live-rollback">
              <summary>Roll back to an earlier version</summary>
              <ul role="list">
                ${older.map(
                  (release) => html`<li>
                    <span><code>${release.sha.slice(0, 7)}</code> built ${when(release.at)}</span>
                    <form method="POST" action="/sites/${site.id}/rollback">
                      <input type="hidden" name="sha" value="${release.sha}" />
                      <button class="secondary" type="submit">Put this back live</button>
                    </form>
                  </li>`,
                )}
              </ul>
            </details>`
          : ""
      }
    </section>
  `;
}

/** When a region or entry last changed, or that it has edits nobody has published. */
export function editedNote(draft: boolean, edited?: { author: string; date: string }) {
  if (draft) return html`<span class="badge warn">Unsaved edits</span>`;
  return edited ? html`<span>Edited ${ago(edited.date)} by ${edited.author}</span>` : "";
}

/** "12 posts in ", ahead of the folder they live in. */
function countOf(count: number | undefined, entryLabel = "entry") {
  return count === undefined ? "" : `${count} ${count === 1 ? entryLabel : plural(entryLabel)} in `;
}

/** Recent commits to content, from Git, so changes made outside the studio show too. */
function recentPanel(changes: ContentChange[]) {
  const SHOWN = 4;
  return html`
    <section class="resource-section" aria-labelledby="recent-heading">
      <div class="resource-heading">
        <h2 id="recent-heading">${icon("history")} Recent changes</h2>
        <span>from Git</span>
      </div>
      <ol class="activity" role="list">
        ${changes.map(
          (change) => html`<li>
            <div class="activity-head">
              <strong>${change.subject}</strong>
              <span class="muted"
                >${change.author} · ${ago(change.date)} ·
                <code title="${change.sha}">${change.sha.slice(0, 7)}</code></span
              >
            </div>
            <ul class="touched" role="list">
              ${change.touched
                .slice(0, SHOWN)
                .map((item) =>
                  item.removed
                    ? html`<li><s>${item.label}</s> <span class="muted">removed</span></li>`
                    : html`<li><a href="${item.href}">${item.label}</a></li>`,
                )}
              ${
                change.touched.length > SHOWN
                  ? html`<li class="muted">and ${change.touched.length - SHOWN} more</li>`
                  : ""
              }
            </ul>
          </li>`,
        )}
      </ol>
    </section>
  `;
}

export function sitePage(options: {
  site: Site;
  schema: CmsSchema;
  flash?: PageOptions["flash"];
  drafts?: UnsavedDraft[];
  /** This site's form address, e.g. https://studio.example.com/f/<id>. */
  formsEndpoint?: string;
  sync?: SyncState | null;
  /** The branch publishes land on, and where to review them on GitHub. */
  branch?: BranchState | null;
  reviewUrl?: string;
  live?: LiveSite | null;
  scheduled?: { jobs: Scheduled[]; timeZone: string; owner?: string };
  running?: boolean | null;
  activity?: Activity;
  /** Entries per collection, by collection name. */
  counts?: Record<string, number>;
}): string {
  const { site, schema, flash, formsEndpoint, sync, live, scheduled, running, branch } = options;
  const owner = viewer()?.owner !== false;
  const drafts = options.drafts ?? [];
  const drafted = new Set(drafts.map((draft) => draft.target));
  const edited = options.activity?.edited ?? new Map<string, { author: string; date: string }>();
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
          <h1 class="site-title">${siteAvatar(site.id, "avatar large")} ${site.name}</h1>
          ${
            owner
              ? html`<a class="button secondary" href="/sites/${site.id}/settings"
                  >${icon("settings")} Site settings</a
                >`
              : ""
          }
        </div>
        <p class="lede">
          Choose a part of the site to edit. Its content stays in your working copy.
        </p>
      </div>

      <dl class="workspace-meta">
        ${
          owner
            ? html`<div>
                <dt>Working copy</dt>
                <dd><code title="${site.path}">${shortPath(site.path)}</code></dd>
              </div>`
            : ""
        }
        <div>
          <dt>Live preview</dt>
          <dd>
            ${
              site.devUrl
                ? running === false
                  ? html`<span class="status down">Not running</span>
                      <span class="hint"><code>${hostOf(site.devUrl)}</code></span>`
                  : html`<a
                        class="status ready open-site"
                        href="${site.devUrl}"
                        target="_blank"
                        rel="noopener"
                        title="Open ${site.devUrl} in a new tab"
                        ><span class="status-text">Running</span>${icon("external")}</a
                      >
                      <span class="hint"><code>${hostOf(site.devUrl)}</code></span>`
                : owner
                  ? html`<a href="/sites/${site.id}/settings">Add your dev server</a>`
                  : "Not set up"
            }
          </dd>
        </div>
        <div>
          <dt>Publishing</dt>
          <dd>
            ${
              site.pushAfterPublish
                ? html`One commit, pushed to
                    <code
                      >${
                        sync?.upstream ??
                        (branch?.branch && branch.remote
                          ? `${branch.remote}/${branch.branch}`
                          : "its upstream")
                      }</code
                    >`
                : branch?.branch
                  ? html`One commit on <code>${branch.branch}</code>`
                  : "One commit"
            }
            ${
              options.reviewUrl
                ? html`<br /><a href="${options.reviewUrl}">Review and merge on GitHub</a>`
                : ""
            }
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
                  Committed in the working copy and not yet on
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
                <p class="card-meta">
                  ${editedNote(drafted.has(`regions/${id}`), edited.get(`regions/${id}`))}
                </p>
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
                        <p>
                          ${countOf(options.counts?.[name], collection.entryLabel)}<code
                            >${collection.path}</code
                          >
                        </p>
                        <p class="card-meta">
                          ${editedNote(
                            drafts.some((draft) => draft.target.startsWith(`collections/${name}/`)),
                            edited.get(`collections/${name}`),
                          )}
                        </p>
                      </li>
                    `,
                  )}
                </ul>
              </section>
            `
          : ""
      }
      ${live ? livePanelFor(site, live) : ""}
      ${scheduled && scheduled.jobs.length > 0 ? scheduledPanel(site, scheduled.jobs, scheduled.timeZone, scheduled.owner) : ""}
      ${options.activity && options.activity.recent.length > 0 ? recentPanel(options.activity.recent) : ""}
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
                ${highlightHtml(`<form method="POST" action="${formsEndpoint}/contact">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required>
  <label for="message">Message</label>
  <textarea id="message" name="message" required></textarea>
  <input type="hidden" name="_redirect" value="/thanks/">
  <button>Send</button>
</form>`)}
              </section>
            `
          : ""
      }
    `,
  );
}
