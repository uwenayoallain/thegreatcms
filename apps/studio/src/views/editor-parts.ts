/** Pieces every editor screen shares: the framed preview, the site's sidebar, and the notices above a form. */

import type { CmsSchema } from "@greatcms/spec";
import type { Elsewhere } from "../elsewhere.js";
import { html, raw } from "hono/html";
import type { Site } from "../db.js";
import { studioTimeZone } from "../schedule.js";
import { type SiteNav } from "./layout.js";
import { icon } from "./icons.js";

/** The preview beside an editor: the site's own dev server, framed, with a phone-width toggle. */
export function livePanel(
  site: Site,
  options: {
    draft?: string;
    url?: string;
    empty: ReturnType<typeof html>;
    elsewhere?: Elsewhere[];
    /** Whether the dev server answered the studio: false says so over the frame. */
    running?: boolean | null;
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
                  <button
                    class="icon-button"
                    type="submit"
                    form="share-form"
                    title="Share a preview link"
                  >
                    ${icon("link", "Share a preview link")}
                  </button>
                </div>
              `
            : ""
        }
        ${
          framed
            ? html`<form method="POST" action="/sites/${site.id}/share" id="share-form" hidden>
                <input type="hidden" name="path" value="${pathOf(url)}" />
              </form>`
            : ""
        }
        <p class="muted" id="live-status" role="status">
          ${
            !url
              ? "No dev server connected"
              : options.running === false
                ? "Its dev server is not running"
                : "Showing what is published"
          }
        </p>
      </div>
      ${
        framed
          ? html`
              <div class="live-stage${options.running === false ? " is-down" : ""}">
                ${
                  options.running === false
                    ? html`<div class="live-down" role="note">
                        ${icon("monitor")}
                        <p><strong>${url?.replace(/^https?:\/\//, "")} is not running.</strong></p>
                        <p>
                          Start the site's dev server, then reload. Your edits are kept as a draft
                          and show the moment it is back; publishing works either way.
                        </p>
                      </div>`
                    : ""
                }
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

export function pendingMediaNotice(token?: string) {
  return token
    ? html`<input type="hidden" name="pendingMedia" value="${token}" />
        <p class="hint" role="status">
          Selected images are kept for this form for 24 hours. Publish to save them with your
          content; keep this tab open until then.
        </p>`
    : "";
}

/** The sidebar's map of a site: every region and collection, with the one being edited marked. */
export function siteNav(site: Site, schema: CmsSchema, current?: string): SiteNav {
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
const minutes = (at: number) => Math.max(1, Math.round((Date.now() - at) / 60_000));

/** Someone else is in the same content: whoever publishes second is refused, so say it before then. */
/** One list every image field's URL box offers, so an upload can be used again without uploading it again. */
export function mediaList(media: string[] = []) {
  return media.length > 0
    ? html`<datalist id="site-media">
        ${media.map((src) => html`<option value="${src}"></option>`)}
      </datalist>`
    : "";
}

export function entryLists(entries: Record<string, Array<{ slug: string; title: string }>> = {}) {
  return Object.entries(entries).map(
    ([name, list]) =>
      html`<datalist id="entries-${name}">
        ${list.map((entry) => html`<option value="${entry.slug}">${entry.title}</option>`)}
      </datalist>`,
  );
}

export function presenceNotice(others: Array<{ name: string; seenAt: number }> = []) {
  if (others.length === 0) return "";
  const names = others
    .map((other) => `${other.name} (${minutes(other.seenAt)} min ago)`)
    .join(", ");
  return html`<div class="presence-notice" role="status">
    ${icon("users")}
    <p>
      <strong>Also open here: ${names}.</strong> If you both publish, the second publish is refused
      rather than overwriting the first.
    </p>
  </div>`;
}

/** "Publish later": a time in the studio's zone and a second submit button. Plain HTML. */
export function scheduleControl() {
  return html`<details class="schedule">
    <summary>${icon("clock")} Publish later</summary>
    <div class="schedule-panel">
      <label for="publishAt">When <span class="muted">(${studioTimeZone()})</span></label>
      <input type="datetime-local" id="publishAt" name="publishAt" />
      <button class="secondary" type="submit" name="action" value="schedule">Schedule</button>
    </div>
  </details>`;
}

export function draftNotice(discard: string, stale = false) {
  return html`
    <div class="draft-notice${stale ? " is-stale" : ""}" role="status">
      ${icon("pen")}
      <p>
        ${
          stale
            ? html`<strong>Someone published this since your unsaved edits began.</strong>
                Publishing them would overwrite that change, so it will be refused. Discard them to
                start from what is published now.`
            : html`<strong>This form holds unsaved edits.</strong> It and the preview show them, not
                what is published; nothing changes on the site until you publish.`
        }
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

/** The page a preview address is on, which is where a shared link should open. */
function pathOf(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}`;
  } catch {
    return "/";
  }
}
