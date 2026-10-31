/** Search across a site's content, and the history of one file. */

import { when } from "./locale.js";
import type { CmsSchema } from "@greatcms/spec";
import { html } from "hono/html";
import type { Site } from "../db.js";
import type { HistoryEntry } from "../repo.js";
import type { SearchHit } from "../search.js";
import { page } from "./layout.js";
import { icon } from "./icons.js";
import { siteNav } from "./editor-parts.js";

export function searchPage(options: {
  site: Site;
  schema: CmsSchema;
  query: string;
  hits: SearchHit[];
}): string {
  const { site, schema, query, hits } = options;
  return page(
    {
      title: query ? `Search: ${query}` : "Search",
      section: "sites",
      site: siteNav(site, schema, "search"),
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
        { href: `/sites/${site.id}/search`, label: "Search" },
      ],
    },
    html`
      <div class="page-head">
        <h1>Search ${site.name}</h1>
      </div>
      <form
        method="GET"
        action="/sites/${site.id}/search"
        class="search-form"
        role="search"
        aria-label="Search ${site.name}"
      >
        <label class="visually-hidden" for="q">Search the content</label>
        <input
          type="search"
          id="q"
          name="q"
          value="${query}"
          placeholder="Words on the site"
          autofocus
        />
        <button type="submit">${icon("search")} Search</button>
      </form>
      ${
        query.trim().length < 2
          ? html`<p class="muted">
              Every region and entry, drafts included. Type at least two letters.
            </p>`
          : hits.length === 0
            ? html`<p class="muted">Nothing on this site says “${query}”.</p>`
            : html`<p class="muted">
                  ${hits.length}${hits.length >= 60 ? "+" : ""}
                  ${hits.length === 1 ? "place" : "places"}
                </p>
                <ol class="search-hits" role="list">
                  ${hits.map(
                    (hit) => html`<li>
                      <a href="${hit.href}">
                        <span class="hit-place">${hit.place} · ${hit.label}</span>
                        <span class="hit-text"
                          >${hit.before}<mark>${hit.match}</mark>${hit.after}</span
                        >
                      </a>
                    </li>`,
                  )}
                </ol>`
      }
    `,
  );
}

export function historyPage(options: {
  site: Site;
  schema: CmsSchema;
  label: string;
  back: string;
  entries: HistoryEntry[];
}): string {
  const { site, schema, label, back, entries } = options;
  const path = back.slice(`/sites/${site.id}/`.length);
  return page(
    {
      title: `History of ${label}`,
      section: "sites",
      site: siteNav(site, schema, path),
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
        { href: back, label },
        { href: `${back}/history`, label: "History" },
      ],
    },
    html`
      <div class="page-head">
        <h1>History of ${label}</h1>
        <p class="lede">
          Every publish is a commit. Restoring opens that version in the editor as an unsaved edit,
          so you see it in the preview before publishing it back.
        </p>
      </div>
      ${
        entries.length === 0
          ? html`<div class="empty">
              <h2>No versions yet</h2>
              <p>
                Each publish adds one here. Nothing has been committed to this file yet, or the
                folder is not a Git repository.
              </p>
            </div>`
          : html`<ol class="history" role="list">
              ${entries.map(
                (entry, index) => html`<li>
                  <div>
                    <strong>${entry.subject}</strong>
                    <span class="muted"
                      >${entry.author} · <time datetime="${entry.date}">${when(entry.date)}</time> ·
                      <code>${entry.sha.slice(0, 7)}</code></span
                    >
                  </div>
                  ${
                    index === 0
                      ? html`<span class="badge">Published now</span>`
                      : html`<form method="POST" action="${back}/history/${entry.sha}/restore">
                          <button class="secondary" type="submit">
                            ${icon("history")} Restore this version
                          </button>
                        </form>`
                  }
                </li>`,
              )}
            </ol>`
      }
    `,
  );
}
