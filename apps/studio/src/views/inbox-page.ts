/** Form submissions a site has received. */

import { when } from "./locale.js";
import { html } from "hono/html";
import type { Site, Submission } from "../db.js";
import { page, type PageOptions } from "./layout.js";

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
          Form submissions from every connected site. Sites post a plain HTML form here: no
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
