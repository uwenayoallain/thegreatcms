/** Server-rendered HTML for the whole studio. */

import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { assetUrl } from "../assets.js";
import { icon } from "./icons.js";
import { locale } from "./locale.js";

export interface Crumb {
  href: string;
  label: string;
}

/** The site a screen belongs to, and everything editable in it, so the sidebar is the site's map. */
export interface SiteNav {
  id: string;
  name: string;
  devUrl?: string | null;
  regions?: Array<{ id: string; label: string }>;
  collections?: Array<{ name: string; label: string }>;
  /** The region id or collection name being edited, marked in the tree. */
  current?: string;
}

export interface PageOptions {
  title: string;
  crumbs?: Crumb[];
  /** Announced to screen readers on arrival, e.g. after a publish. */
  flash?: { kind: "success" | "error"; message: string; detail?: string[] };
  /** Load the visual editor. */
  editor?: boolean;
  /** Load the live preview enhancement. */
  liveSite?: boolean;
  /** Which nav item is the page you are on. */
  section?: "sites" | "inbox";
  /** Unread submissions, shown on the inbox link so it is worth glancing at. */
  unread?: number;
  /** Signed-out screens get the shell without the navigation. */
  chrome?: boolean;
  site?: SiteNav;
}

export function page(
  options: PageOptions,
  body: HtmlEscapedString | Promise<HtmlEscapedString> | string,
): string {
  const {
    title,
    crumbs = [],
    flash,
    editor = false,
    liveSite = false,
    section,
    unread = 0,
    chrome = true,
    site,
  } = options;

  return `<!doctype html>${html`
    <html lang="${locale()}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f4f4f2" />
        <meta name="robots" content="noindex" />
        <title>${title} — GreatCMS Studio</title>
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="stylesheet" href="${assetUrl("studio.css")}" />
      </head>
      <body class="${chrome ? "" : "plain"}">
        <a class="skip-link" href="#main">Skip to content</a>

        ${chrome ? navigation(section, unread, site, liveSite) : ""}

        <div class="content">
          ${
            chrome && crumbs.length > 0
              ? html`
                  <nav aria-label="Breadcrumb" class="crumbs">
                    <ol>
                      ${crumbs.map(
                        (crumb, index) => html`
                          <li>
                            ${
                              index === crumbs.length - 1
                                ? html`<span aria-current="page">${crumb.label}</span>`
                                : html`<a href="${crumb.href}">${crumb.label}</a>`
                            }
                          </li>
                        `,
                      )}
                    </ol>
                  </nav>
                `
              : ""
          }

          <main id="main">
            ${
              flash
                ? html`
                    <div
                      class="flash ${flash.kind}"
                      role="${flash.kind === "error" ? "alert" : "status"}"
                      tabindex="-1"
                      id="flash"
                    >
                      ${icon(flash.kind === "error" ? "alert" : "check")}
                      <div>
                        ${flashMessage(flash.message)}
                        ${
                          flash.detail && flash.detail.length > 0
                            ? html`<ul>
                                ${flash.detail.map((line) => html`<li>${line}</li>`)}
                              </ul>`
                            : ""
                        }
                      </div>
                    </div>
                  `
                : ""
            }
            ${body}
          </main>
        </div>

        ${editor ? html`<script type="module" src="${assetUrl("editor.js")}"></script>` : ""}
        ${
          liveSite
            ? html`<script type="module" src="${assetUrl("live.js")}"></script>
                <script type="module" src="${assetUrl("form.js")}"></script>
                <script type="module" src="${assetUrl("shell.js")}"></script>`
            : ""
        }
      </body>
    </html>
  `}`;
}

/** The mark: a G whose crossbar is a commit, the one thing a publish becomes. */
export function brandMark() {
  return raw(
    '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#15171a"/><path d="M22.9 10.2A9 9 0 1 0 25 16" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/><path d="M25 16h-7" stroke="#fff" stroke-width="5" stroke-linecap="round"/><circle cx="17.5" cy="16" r="3.6" fill="#1fbf8a"/></svg>',
  );
}

/** The one place every screen is reachable from, so no page is a dead end. */
function navigation(
  section: PageOptions["section"],
  unread: number,
  site?: SiteNav,
  resizable = false,
) {
  const current = (name: PageOptions["section"]) => (section === name ? "page" : undefined);

  return html`
    <header class="sidebar">
      ${
        resizable
          ? html`<div
              class="handle sidebar-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the sidebar"
              aria-valuenow="248"
              tabindex="0"
              data-resize-sidebar
              hidden
            ></div>`
          : ""
      }
      <a class="brand" href="/">
        ${brandMark()}
        <span>GreatCMS <small>Studio</small></span>
      </a>
      <nav aria-label="Sections">
        <ul>
          <li>
            <a href="/" aria-current="${current("sites")}">${icon("sites")} Sites</a>
          </li>
          <li>
            <a href="/inbox" aria-current="${current("inbox")}">
              ${icon("inbox")} Inbox
              ${
                unread > 0
                  ? html`<span class="count"
                      >${unread}<span class="visually-hidden"> unread</span></span
                    >`
                  : ""
              }
            </a>
          </li>
        </ul>
      </nav>
      ${
        site
          ? html`
              <nav aria-label="This site" class="site-nav">
                <p class="sidebar-label">Site</p>
                <ul>
                  <li>
                    <a
                      class="site-name"
                      href="/sites/${site.id}"
                      aria-current="${site.current === undefined && section === "sites" ? "page" : undefined}"
                      >${icon("globe")} ${site.name}</a
                    >
                  </li>
                </ul>
                ${
                  site.collections && site.collections.length > 0
                    ? html`<p class="sidebar-label tree-label">Collections</p>
                        <ul class="tree">
                          ${site.collections.map(
                            (collection) => html`<li>
                              <a
                                href="/sites/${site.id}/collections/${collection.name}"
                                aria-current="${site.current === `collections/${collection.name}` ? "page" : undefined}"
                                >${icon("layers")} ${collection.label}</a
                              >
                            </li>`,
                          )}
                        </ul>`
                    : ""
                }
                ${
                  site.regions && site.regions.length > 0
                    ? html`<p class="sidebar-label tree-label">Page regions</p>
                        <ul class="tree">
                          ${site.regions.map(
                            (region) => html`<li>
                              <a
                                href="/sites/${site.id}/regions/${region.id}"
                                aria-current="${site.current === `regions/${region.id}` ? "page" : undefined}"
                                >${icon("file")} ${region.label}</a
                              >
                            </li>`,
                          )}
                        </ul>`
                    : ""
                }
                <ul class="tree site-tools">
                  <li>
                    <a href="/inbox?site=${encodeURIComponent(site.id)}"
                      >${icon("mail")} Submissions</a
                    >
                  </li>
                  <li>
                    <a href="/sites/${site.id}/settings">${icon("settings")} Settings</a>
                  </li>
                  ${
                    site.devUrl
                      ? html`<li>
                          <a href="${site.devUrl}" target="_blank" rel="noopener"
                            >${icon("external")} Open site</a
                          >
                        </li>`
                      : ""
                  }
                </ul>
              </nav>
            `
          : ""
      }
      <form method="POST" action="/sign-out" class="sign-out">
        <button class="link" type="submit">${icon("signOut")} Sign out</button>
      </form>
    </header>
  `;
}

const STYLES = `
/* The same identity as the website: stone surfaces, tight near-black type, mono only for what is a file, one green for publishing. */
:root {
  color-scheme: light dark;
  --canvas: #f4f4f2;
  --surface: #ffffff;
  --surface-2: #eeeeeb;
  --ink: #15171a;
  --ink-2: #555961;
  --ink-3: #62666d;
  --line: #e1e2de;
  --line-2: #c7c9c3;
  --accent: #0d7a5f;
  --accent-strong: #0a614b;
  --accent-soft: #e1f2eb;
  --accent-ink: #ffffff;
  --warn: #9a5508;
  --warn-bg: #fdf1e3;
  --danger: #b3281e;
  --danger-bg: #fbeae8;
  --ok: #0d7a5f;
  --ok-bg: #e1f2eb;
  --focus: #0d7a5f;
  --ring: rgba(13, 122, 95, .22);
  --radius: 10px;
  --radius-sm: 7px;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace;
  --sans: "Inter", "SF Pro Text", "Segoe UI Variable Text", "Helvetica Neue", system-ui, sans-serif;
  --shadow: 0 1px 2px rgba(21, 23, 26, .04);
  --shadow-lift: 0 2px 6px -2px rgba(21, 23, 26, .08);
  --pop: 0 8px 24px -12px rgba(0, 0, 0, .25);
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #101113;
    --surface: #17191c;
    --surface-2: #202226;
    --ink: #e9eaec;
    --ink-2: #a6aab0;
    --ink-3: #8d9198;
    --line: #2a2d32;
    --line-2: #3e4248;
    --accent: #43c99a;
    --accent-strong: #6ad8b1;
    --accent-soft: #11302a;
    --accent-ink: #0f1b17;
    --warn: #f0b36b;
    --warn-bg: #33230f;
    --danger: #ffa399;
    --danger-bg: #3a1613;
    --ok: #43c99a;
    --ok-bg: #11302a;
    --focus: #43c99a;
    --ring: rgba(67, 201, 154, .3);
    --shadow: 0 1px 0 rgba(0, 0, 0, .3);
    --shadow-lift: 0 2px 6px -2px rgba(0, 0, 0, .4);
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-padding-top: 5rem; }
body {
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font: 14.5px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "ss01", "cv11", "tnum";
  display: grid;
  grid-template-columns: var(--sidebar-width, 15.5rem) minmax(0, 1fr);
  min-height: 100vh;
}
/* The lines you can drag: a hairline that widens into a grip under the pointer. */
.handle { position: relative; width: .6rem; cursor: col-resize; z-index: 5; touch-action: none; }
.handle::before { content: ""; position: absolute; inset: 0 auto 0 50%; width: 1px; background: transparent; transition: background .15s, width .15s; }
.handle:hover::before, .handle:focus-visible::before, .is-resizing .handle::before { width: 3px; margin-left: -1px; background: var(--accent); }
.handle:focus-visible { outline: none; }
.sidebar-handle { position: absolute; top: 0; bottom: 0; right: -.3rem; margin: 0; }
.split-handle { align-self: stretch; }
.is-resizing { cursor: col-resize; user-select: none; }
.is-resizing iframe { pointer-events: none; }
body.plain { display: block; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 3px; }
.skip-link {
  position: absolute; left: .5rem; top: -3rem; z-index: 20;
  padding: .55rem 1rem; background: var(--ink); color: var(--canvas);
  border-radius: var(--radius-sm); text-decoration: none; font-weight: 600; font-size: .85rem;
}
.skip-link:focus { top: .5rem; }
.icon { width: 1.1em; height: 1.1em; flex: none; vertical-align: -.2em; }
.stamp, .sidebar-label { font-size: .7rem; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-3); margin: 0; }

/* Navigation: a quiet column, the current place marked in green. */
.sidebar {
  position: sticky; top: 0; align-self: start; height: 100vh; z-index: 6;
  background: var(--surface); border-right: 1px solid var(--line);
  padding: .9rem .75rem 1rem;
  display: flex; flex-direction: column; gap: 1.25rem;
}
.brand {
  display: flex; align-items: center; gap: .6rem;
  font-size: .92rem; font-weight: 800; letter-spacing: .02em; text-transform: uppercase; line-height: 1.05;
  text-decoration: none; color: inherit; padding: .4rem .55rem .95rem;
  border-bottom: 1px solid var(--line);
}
.brand small { display: block; margin-top: .3rem; color: var(--ink-3); font-size: .58rem; font-weight: 650; letter-spacing: .18em; }
.brand .mark { width: 1.75rem; height: 1.75rem; flex: none; border-radius: 7px; }
.sidebar nav ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .1rem; }
.sidebar nav a {
  display: flex; align-items: center; gap: .65rem;
  padding: .48rem .65rem; border-radius: var(--radius-sm);
  text-decoration: none; color: var(--ink-2); font-weight: 500; font-size: .9rem;
  transition: background .12s, color .12s;
}
.sidebar nav a .icon { width: 1.05rem; height: 1.05rem; color: var(--ink-3); }
.sidebar nav a:hover { background: var(--surface-2); color: var(--ink); }
.sidebar nav a:hover .icon { color: var(--ink); }
.sidebar nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.sidebar nav a[aria-current="page"] .icon { color: var(--accent); }
.count {
  margin-left: auto; min-width: 1.4rem; text-align: center; font-size: .72rem; font-weight: 650; line-height: 1.5;
  background: var(--accent); color: var(--accent-ink);
  padding: .05rem .4rem; border-radius: 999px;
}
.sidebar-label { padding: 0 .65rem .45rem; }
.site-nav { padding-top: 1rem; border-top: 1px solid var(--line); min-height: 0; overflow-y: auto; }
.site-nav .tree-label { padding-top: .9rem; }
.site-nav .tree a { padding: .38rem .65rem; font-size: .88rem; }
.site-nav .site-tools { margin-top: .9rem; padding-top: .6rem; border-top: 1px solid var(--line); }
.site-nav .site-name { color: var(--ink); font-weight: 650; }
.site-nav .site-name .icon { color: var(--accent); }
.sign-out { margin-top: auto; padding: .75rem .1rem 0; border-top: 1px solid var(--line); }
.sidebar button.link { display: inline-flex; align-items: center; gap: .55rem; padding: .4rem .55rem; color: var(--ink-2); font-size: .88rem; text-decoration: none; border-radius: var(--radius-sm); }
.sidebar button.link:hover { color: var(--ink); background: var(--surface-2); }
@media (max-width: 52rem) {
  body { grid-template-columns: minmax(0, 1fr); }
  .sidebar-handle { display: none; }
  .sidebar {
    position: static; height: auto;
    flex-direction: row; flex-wrap: wrap; align-items: center; gap: .5rem .75rem;
    border-right: 0; border-bottom: 1px solid var(--line); padding: .6rem .9rem;
  }
  .brand { margin-right: auto; padding: .15rem .25rem; border-bottom: 0; }
  .sidebar nav { order: 3; flex: 1 0 100%; }
  .sidebar nav ul { display: flex; flex-wrap: wrap; gap: .25rem; }
  .sidebar-label { display: none; }
  .site-nav { padding-top: 0; border-top: 0; }
  .sign-out { margin: 0; padding: 0; border: 0; }
}

/* Content column. */
.content { display: flex; flex-direction: column; min-width: 0; }
.crumbs {
  position: sticky; top: 0; z-index: 6;
  padding: .7rem 2.25rem; border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--canvas) 86%, transparent); backdrop-filter: blur(12px);
}
.crumbs ol { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; list-style: none; margin: 0; padding: 0; font-size: .82rem; color: var(--ink-2); }
.crumbs a { color: var(--ink-2); text-decoration: none; }
.crumbs a:hover { color: var(--ink); text-decoration: underline; }
.crumbs li { display: flex; align-items: center; gap: .5rem; }
.crumbs li + li::before { content: ""; width: .85rem; height: .85rem; background: currentColor; opacity: .4; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 18 6-6-6-6'/%3E%3C/svg%3E") center / contain no-repeat; }
.crumbs [aria-current="page"] { color: var(--ink); font-weight: 600; }
main { width: 100%; max-width: 66rem; margin: 0 auto; padding: 2.5rem 2.25rem 6rem; }
body.plain main { max-width: 25rem; margin: 0 auto; padding: 5rem 1.25rem; }
@media (max-width: 42rem) {
  .crumbs { position: static; padding: .6rem 1rem; }
  main { padding: 1.5rem 1rem 4rem; }
  body { font-size: 15px; }
  fieldset, fieldset .blocks-field { padding: .85rem .9rem 1rem; border-radius: var(--radius-sm); }
  fieldset fieldset { padding-left: .8rem; }
  input[type=text], input[type=url], input[type=number], input[type=date], input[type=password], input[type=email], select { min-height: 2.9rem; font-size: 16px; }
  textarea { font-size: 16px; }
  input[type=number], input[type=date] { max-width: none; }
  .row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  button, .button { min-height: 2.75rem; }
  .field { margin-bottom: 1rem; }
}

/* Typography. */
h1 { font-size: 1.7rem; font-weight: 650; line-height: 1.15; margin: 0 0 .35rem; letter-spacing: -.035em; }
h2 { font-size: 1.05rem; font-weight: 650; margin: 2.25rem 0 .75rem; letter-spacing: -.015em; }
h3 { font-size: .95rem; font-weight: 650; margin: 1.5rem 0 .5rem; letter-spacing: -.01em; }
h1, h2, h3 { text-wrap: balance; }
p { max-width: 64ch; }
a { color: inherit; touch-action: manipulation; text-decoration-color: var(--line-2); text-underline-offset: .18em; }
a:hover { text-decoration-color: var(--accent); }
.muted { color: var(--ink-2); }
.lede { color: var(--ink-2); margin: 0 0 1.75rem; font-size: .95rem; }
.page-head { margin-bottom: 2rem; }
.page-head .lede { margin-bottom: 0; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.page-head:has(> .section-head) { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 1rem; align-items: start; }
.page-head > .section-head { display: contents; }
.page-head > .section-head > h1 { grid-area: 1 / 1; }
.page-head > .section-head > .button { grid-area: 1 / 2; margin-top: .15rem; }
.page-head:has(> .section-head) > .lede { grid-area: 2 / 1; }
@media (max-width: 42rem) {
  .page-head:has(> .section-head) { grid-template-columns: minmax(0, 1fr); }
  .page-head > .section-head > .button { grid-area: 3 / 1; justify-self: start; margin-top: 1rem; }
}
.section-head h1 { margin-bottom: .35rem; }
.section-head h2 { margin-bottom: .75rem; }

/* Flash. */
.flash { display: flex; gap: .75rem; align-items: start; padding: .85rem 1rem; border-radius: var(--radius); margin-bottom: 1.5rem; border: 1px solid; }
.flash > .icon { width: 1.2rem; height: 1.2rem; margin-top: .1rem; }
.flash > div { min-width: 0; flex: 1; }
.flash p { margin: 0; font-weight: 600; max-width: none; }
.flash p.fix { margin-top: .3rem; font-weight: 400; }
.flash ul { margin: .5rem 0 0; padding-left: 1.1rem; font-weight: 400; }
.flash.success { background: var(--ok-bg); color: var(--ok); border-color: color-mix(in srgb, var(--ok) 25%, transparent); }
.flash.error { background: var(--danger-bg); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 25%, transparent); }

/* Cards. */
.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: .75rem; }
.cards.two { grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); }
.card {
  position: relative;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 1rem 1.15rem; box-shadow: var(--shadow);
  transition: border-color .15s, box-shadow .15s, transform .15s;
}
.card:has(> :is(h2, h3, .card-topline) a:not(.card-action)):hover { border-color: var(--line-2); transform: translateY(-1px); }
.card :is(h2, h3) { margin: 0 0 .25rem; font-size: .98rem; }
.card :is(h2, h3) a { text-decoration: none; }
.card :is(h2, h3) a::after { content: ""; position: absolute; inset: 0; }
.card :is(h2, h3) a:hover { color: var(--accent); }
.card p { margin: 0; color: var(--ink-2); font-size: .85rem; }
.card p code { font-size: .78rem; }
.card-topline { display: flex; align-items: start; justify-content: space-between; gap: .75rem; }
.card-topline h2, .card-topline h3 { flex: 1 1 auto; min-width: 0; }
.card-action { position: relative; z-index: 1; flex: none; display: inline-flex; align-items: center; gap: .25rem; color: var(--accent); font-weight: 600; font-size: .8rem; text-decoration: none; padding: .15rem .55rem; margin: -.15rem -.55rem 0 0; border-radius: 999px; }
.card-action:hover { background: var(--accent-soft); }
.card-action::before { content: "+"; font-weight: 700; }
.card .path { margin-top: .3rem; overflow-wrap: anywhere; }
.status { display: inline-flex; align-items: center; gap: .4rem; flex: none; white-space: nowrap; color: var(--ink-2); font-weight: 600; font-size: .78rem; }
.status::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: var(--line-2); }
.status.ready::before { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
.workspace-meta { display: grid; grid-template-columns: minmax(0, 2fr) repeat(2, minmax(9rem, 1fr)); margin: 0 0 2rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); overflow: hidden; }
.workspace-meta > div { min-width: 0; padding: .85rem 1.1rem; }
.workspace-meta > div + div { border-left: 1px solid var(--line); }
.workspace-meta dt { color: var(--ink-3); font-size: .68rem; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; }
.workspace-meta dd { margin: .35rem 0 0; overflow-wrap: anywhere; font-weight: 600; font-size: .92rem; }
.workspace-meta dd code { font-size: .8rem; font-weight: 500; }
.workspace-meta dd .hint { margin-top: .15rem; }
.resource-section { margin-top: 2.5rem; }
.resource-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: .85rem; }
.resource-heading h2 { margin: 0; }
.resource-heading > span { color: var(--ink-2); font-size: .8rem; }
@media (max-width: 42rem) {
  .workspace-meta { grid-template-columns: minmax(0, 1fr); }
  .workspace-meta > div + div { border-left: 0; border-top: 1px solid var(--line); }
  .card-topline { display: block; }
  .card-topline .status { margin-top: .3rem; }
  table { display: block; overflow-x: auto; white-space: nowrap; }
}

/* Empty states earn their space: say what to do, not just that there is nothing. */
.empty {
  border: 1px dashed var(--line-2); border-radius: var(--radius);
  padding: 2.5rem 1.5rem; text-align: center; background: var(--surface);
}
.empty h2 { margin: 0 0 .35rem; font-size: 1.05rem; }
.empty p { margin: 0 auto 1.1rem; color: var(--ink-2); max-width: 38ch; }

/* Forms. */
fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: .75rem .9rem .85rem; margin: 0 0 .85rem; background: var(--surface); min-width: 0; box-shadow: var(--shadow); }
/* The legend sits inside the box as its heading, not astride the border. */
legend { float: left; width: 100%; padding: 0; margin: 0 0 .55rem; font-weight: 650; font-size: .86rem; color: var(--ink); letter-spacing: -.01em; }
legend + * { clear: both; }
fieldset > .hint:first-of-type { margin-top: -.35rem; margin-bottom: .85rem; }
/* One level in, the box becomes a rule: boxes inside boxes read as clutter, and worse on a phone. */
fieldset fieldset { box-shadow: none; background: transparent; border: 0; border-left: 2px solid var(--line); border-radius: 0; padding: .1rem 0 .1rem 1rem; margin: .25rem 0 1rem; }
fieldset fieldset legend { font-size: .8rem; margin-bottom: .45rem; }
fieldset fieldset:last-child { margin-bottom: 0; }
fieldset .blocks-field, .blocks-field .block, .block-fields fieldset.blocks-field { border: 1px solid var(--line); border-radius: var(--radius); padding: .75rem .9rem .85rem; background: var(--surface); }
.block-fields > fieldset { box-shadow: none; }
.field { margin-bottom: .85rem; scroll-margin-top: 5rem; }
.field:last-child { margin-bottom: 0; }
label { display: block; font-weight: 600; margin-bottom: .25rem; font-size: .8rem; }
.hint { display: block; font-weight: 400; font-size: .75rem; color: var(--ink-2); margin-top: .25rem; }
input[type=text], input[type=url], input[type=number], input[type=date], input[type=password], input[type=email], textarea, select {
  width: 100%; min-height: 2.1rem; padding: .35rem .6rem; font: inherit; font-size: .875rem; color: inherit;
  background: var(--surface); border: 1px solid var(--line-2); border-radius: var(--radius-sm);
  transition: border-color .12s, box-shadow .12s;
}
input:hover, textarea:hover, select:hover { border-color: var(--ink-3); }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
input[aria-invalid="true"], textarea[aria-invalid="true"], select[aria-invalid="true"] { border-color: var(--danger); }
::placeholder { color: var(--ink-3); opacity: 1; }
label > span[aria-hidden] { color: var(--accent); }
input[readonly] { background: var(--surface-2); color: var(--ink-2); }
textarea { min-height: 4.5rem; resize: vertical; line-height: 1.5; }
textarea.source { font-family: var(--mono); font-size: .8rem; min-height: 12rem; }
input[type=number] { max-width: 10rem; }
input[type=date] { max-width: 14rem; }
select { appearance: none; padding-right: 2rem; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236f737a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right .55rem center; background-size: .9rem; }
input[type=checkbox], input[type=radio] { width: .95rem; height: .95rem; accent-color: var(--accent); flex: none; margin: .15rem 0 0; }
.checkbox { display: flex; align-items: start; gap: .6rem; margin-bottom: .5rem; }
.checkbox label { margin: 0; font-weight: 500; }
.unpushed { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem 1.5rem; margin: 0 0 1.5rem; padding: .9rem 1.1rem; border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); border-radius: var(--radius); background: var(--warn-bg); color: var(--warn); }
.unpushed p { margin: 0; max-width: 60ch; }
.unpushed code { color: inherit; }
.row { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
.row label { font-size: .85rem; }
input[type=file] { width: 100%; font: inherit; color: var(--ink-2); font-size: .8rem; }
input[type=file]::file-selector-button { font: 600 .8rem/1.4 var(--sans); min-height: 2rem; padding: .3rem .75rem; margin-right: .75rem; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--surface); color: var(--ink); cursor: pointer; transition: border-color .12s, background .12s; }
input[type=file]:hover::file-selector-button { border-color: var(--ink-3); background: var(--surface-2); }
/* The upload: a zone that reads as a target, the native control kept so it works everywhere. */
.upload { padding: .65rem .8rem; border: 1px dashed var(--line-2); border-radius: var(--radius-sm); background: var(--surface-2); }
.upload:has(input:focus-visible) { border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
.upload label { margin-bottom: .5rem; }
.upload .hint { margin-top: .5rem; }
.preview-thumb { display: flex; align-items: center; gap: 1rem; margin: 0 0 1rem; }
.preview-thumb img { max-width: 9rem; max-height: 6rem; width: auto; height: auto; border-radius: var(--radius-sm); border: 1px solid var(--line); display: block; background: var(--surface-2); object-fit: contain; }
.preview-thumb .hint { margin: 0; font-family: var(--mono); font-size: .76rem; overflow-wrap: anywhere; }

/* Buttons. */
.actions { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-top: 1.5rem; }
button, .button {
  display: inline-flex; align-items: center; justify-content: center; gap: .45rem;
  font: 600 .82rem/1.3 var(--sans); min-height: 2.1rem; padding: .35rem .85rem; border-radius: var(--radius-sm);
  border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink);
  cursor: pointer; text-decoration: none; touch-action: manipulation;
  transition: background .35s cubic-bezier(.32,.72,0,1), border-color .35s cubic-bezier(.32,.72,0,1), color .35s cubic-bezier(.32,.72,0,1), transform .35s cubic-bezier(.32,.72,0,1);
}
button:hover, .button:hover { background: var(--accent-strong); border-color: var(--accent-strong); }
button:active, .button:active { transform: scale(.98); }
/* A display rule beats the hidden attribute, so hidden has to say so louder. */
[hidden] { display: none !important; }
button.secondary, .button.secondary { background: var(--surface); color: var(--ink); border-color: var(--line-2); }
button.secondary:hover, .button.secondary:hover { background: var(--surface-2); border-color: var(--ink-3); color: var(--ink); }
button.link { display: inline; min-height: 0; background: none; border: 0; padding: 0; color: var(--ink-2); text-decoration: underline; font-weight: 500; cursor: pointer; }
button.link:hover { color: var(--ink); background: none; }
button.danger { background: var(--surface); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
button.danger:hover { background: var(--danger-bg); color: var(--danger); border-color: var(--danger); }
button:disabled { opacity: .45; cursor: not-allowed; }
button:disabled:hover { background: var(--accent); border-color: var(--accent); }
button.secondary:disabled:hover { background: var(--surface); border-color: var(--line-2); }

.form-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-top: 1.5rem; }
.split .form-actions {
  position: sticky; top: 2.7rem; z-index: 5;
  margin: 0 0 1.25rem; padding: .75rem 0;
  background: color-mix(in srgb, var(--canvas) 90%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line);
}
@media (max-width: 42rem) { .split .form-actions { top: 0; } }

/* The editor and the site beside it: the site gets the room, because it is the point. */
.split { display: grid; gap: 2rem; align-items: start; grid-template-columns: minmax(0, 1fr); }
.split-handle { display: none; }
main:has(> .split) { max-width: none; padding-top: 1.5rem; }
main:has(> .split) .page-head { margin-bottom: .75rem; }
main:has(> .split) h1 { font-size: 1.4rem; }
@media (min-width: 72rem) {
  .split { grid-template-columns: minmax(0, 1fr) auto minmax(20rem, var(--live-width, 46%)); gap: 1.25rem; }
  /* Placed by hand: a hidden handle takes no cell, and the preview must not slide into its column. */
  .split > form { grid-column: 1; }
  .split > .split-handle { grid-column: 2; }
  .split > .live { grid-column: 3; }
  .split-handle:not([hidden]) { display: block; position: sticky; top: 3.5rem; height: calc(100vh - 4.5rem); }
  .live { position: sticky; top: 3.5rem; height: calc(100vh - 4.5rem); display: flex; flex-direction: column; }
  .live-stage { flex: 1 1 auto; min-height: 16rem; }
}
.live { padding: .5rem; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
.live-bar { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; margin: .1rem .35rem .55rem; }
.live-bar h2 { display: inline-flex; align-items: center; gap: .45rem; margin: 0; font-size: .84rem; font-weight: 650; letter-spacing: 0; }
.live-bar h2::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
.live-url { flex: 1 1 10rem; min-width: 0; padding: .2rem .6rem; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); font-family: var(--mono); font-size: .74rem; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-bar p { flex: 1 0 100%; order: 10; margin: .35rem 0 0; font-size: .76rem; color: var(--ink-3); max-width: none; }
.live-tools { display: flex; align-items: center; gap: .35rem; margin-left: auto; }
.live-toggle { display: inline-flex; align-items: center; gap: .3rem; min-height: 1.9rem; margin: 0; padding: 0 .55rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); color: var(--ink-2); font-size: .74rem; font-weight: 600; cursor: pointer; user-select: none; }
.live-toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
.live-toggle .icon { width: .95rem; height: .95rem; }
.live-toggle:hover { color: var(--ink); }
.live-toggle:has(input:checked) { background: var(--accent); color: #fff; border-color: var(--accent); }
.live-toggle:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 1px; }
.icon-button { display: inline-grid; place-items: center; width: 1.9rem; height: 1.9rem; padding: 0; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); color: var(--ink-3); }
.icon-button:hover { color: var(--ink); background: var(--surface); }
.icon-button .icon { width: .95rem; height: .95rem; }
/* What the page pointed at: the field or section lights up as it opens. */
.field.is-picked, .block-collapsible.is-picked { animation: picked 1.6s ease-out both; border-radius: var(--radius-sm); }
@keyframes picked { 0% { box-shadow: 0 0 0 3px var(--accent); } 100% { box-shadow: 0 0 0 3px transparent; } }
.live-devices { display: inline-flex; gap: .15rem; padding: .15rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); }
.live-devices input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
.live-devices label { display: inline-grid; place-items: center; width: 1.9rem; height: 1.6rem; margin: 0; border-radius: 999px; color: var(--ink-3); cursor: pointer; font-weight: 500; }
.live-devices label .icon { width: 1rem; height: 1rem; }
.live-devices label:hover { color: var(--ink); }
.live-devices input:checked + label { background: var(--surface); color: var(--ink); box-shadow: var(--shadow); }
.live-devices input:focus-visible + label { outline: 2px solid var(--focus); outline-offset: 1px; }
.live-stage { display: flex; justify-content: center; align-items: stretch; background: var(--surface-2); border-radius: var(--radius-sm); padding: 0; overflow: hidden; }
.live-frame { width: 100%; height: 30rem; border: 0; background: #fff; display: block; }
/* Desktop: the site laid out at twice the panel's width and shown at half size, so a 600px panel previews a 1200px page. */
@supports (zoom: 0.5) {
  /* Desktop: the site laid out at 1280px and scaled to the pane, so a wide pane shows it near life size. */
  .live:has(#device-desktop:checked) .live-frame { width: calc(100% / var(--live-zoom, 0.5)); height: calc(30rem / var(--live-zoom, 0.5)); zoom: var(--live-zoom, 0.5); }
}
.live:has(#device-phone:checked) .live-stage { padding: .75rem 0; }
.live:has(#device-phone:checked) .live-frame { width: 24.375rem; max-width: 100%; border-radius: 12px; border: 1px solid var(--line); }
.live-frame.real { height: 26rem; }
@media (min-width: 72rem) {
  .live-stage > .live-frame { height: auto; align-self: stretch; }
  @supports (zoom: 0.5) { .live:has(#device-desktop:checked) .live-stage > .live-frame { height: auto; } }
}
.live-actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .35rem 1rem; margin: .5rem .35rem 0; align-items: baseline; }
.live-actions form { margin: 0; }
.live-actions .hint { flex: 1 1 24rem; margin: 0; font-size: .74rem; }
.live-actions .inline-confirm > summary { font-size: .78rem; }
.live-empty { display: grid; place-items: center; min-height: 14rem; padding: 2rem; text-align: center; color: var(--ink-2); background: var(--surface-2); border-radius: var(--radius-sm); }
.live-empty .icon { width: 1.75rem; height: 1.75rem; color: var(--ink-3); margin-bottom: .5rem; }
.live-empty p { margin: 0; font-size: .88rem; max-width: 30ch; }

/* Restored edits: the one thing an editor must not miss before pressing Publish. */
.draft-notice { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem 1rem; margin: 0 0 1.25rem; padding: .8rem 1rem; border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); border-radius: var(--radius); background: var(--warn-bg); color: var(--warn); }
.draft-notice > .icon { width: 1.1rem; height: 1.1rem; }
.draft-notice p { flex: 1 1 18rem; margin: 0; font-size: .88rem; max-width: none; }
.draft-notice .inline-confirm > summary { color: inherit; }
.draft-notice .inline-confirm[open] > summary { margin-bottom: .5rem; }

/* The outline of a long page: every section, in order, one click away. */
.outline { margin: 0 0 1rem; padding: .85rem 1rem .9rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.outline ol { margin: .5rem 0 0; padding: 0 0 0 1.25rem; columns: 2 14rem; column-gap: 1.5rem; font-size: .85rem; line-height: 1.5; }
.outline li { break-inside: avoid; padding: .12rem 0; }
.outline a { text-decoration: none; color: var(--ink); font-weight: 550; }
.outline a span { color: var(--ink-3); font-weight: 400; }
.outline a span::before { content: " · "; }
.outline a:hover { color: var(--accent); }
.outline-add { display: inline-flex; align-items: center; gap: .35rem; margin-top: .7rem; font-size: .82rem; font-weight: 600; color: var(--accent); text-decoration: none; }
.outline-add:hover { text-decoration: underline; }
@media (max-width: 42rem) { .outline ol { columns: 1; } }

/* The draft callout: loud enough to notice, calm enough not to look broken. */
.drafts { border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); border-radius: var(--radius); padding: .9rem 1.1rem; margin: 0 0 1.75rem; background: var(--warn-bg); color: var(--warn); }
.drafts h2 { margin: 0 0 .3rem; font-size: .95rem; }
.drafts p { margin: 0; font-size: .88rem; }
.drafts ul { margin: .6rem 0 0; padding-left: 1.1rem; }
.drafts code { font-size: .78rem; }

/* Blocks. */
.block { border: 1px solid var(--line); border-radius: var(--radius); padding: .75rem .9rem; margin-bottom: .5rem; background: var(--surface); box-shadow: var(--shadow); }
.block > header { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .9rem; padding-bottom: .6rem; border-bottom: 1px solid var(--line); }
.block :is(h2, h3) { margin: 0; font-size: .9rem; }
.block .tools { display: flex; gap: .2rem; align-items: center; }
.block .tools button { min-width: 2rem; min-height: 2rem; padding: 0 .45rem; font: 600 .78rem/1 var(--sans); background: transparent; color: var(--ink-2); border-color: transparent; }
.block .tools button .icon { width: 1rem; height: 1rem; }
.block .tools button:hover:not(:disabled) { background: var(--surface-2); color: var(--ink); border-color: var(--line); }
.block .tools button:disabled:hover { background: transparent; border-color: transparent; }
.block-remove-confirm > summary { display: inline-grid; place-items: center; min-height: 2rem; padding: 0 .6rem; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--ink-2); cursor: pointer; font: 600 .78rem/1 var(--sans); list-style: none; }
.block-remove-confirm > summary::-webkit-details-marker { display: none; }
.block-remove-confirm > summary:hover, .block-remove-confirm[open] > summary { background: var(--surface-2); color: var(--ink); border-color: var(--line); }
.block-remove-confirm > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.block-remove-panel { position: absolute; top: calc(100% + .4rem); right: 0; width: 17rem; max-width: calc(100vw - 4rem); padding: 1rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--pop); overflow-wrap: anywhere; }
.block-remove-panel p { margin: 0 0 .65rem; font-size: .875rem; }
.block .tools .block-remove-panel button { display: inline-flex; min-height: 2.4rem; padding: .5rem .9rem; font: 600 .85rem/1.4 var(--sans); background: var(--danger-bg); color: var(--danger); border-color: var(--danger); }
.block-remove-panel .hint { display: block; margin-top: .65rem; }
.block-collapsible:has(> .tools .block-remove-confirm[open]) { z-index: 2; }
.block-collapsible { position: relative; padding: 0; }
.block-collapsible > details > summary { display: flex; align-items: center; gap: .6rem; min-height: 2.7rem; padding: .5rem 9rem .5rem .8rem; cursor: pointer; list-style: none; border-radius: var(--radius); }
.block-collapsible > details > summary::-webkit-details-marker { display: none; }
.block-collapsible > details > summary::before { content: ""; width: 1rem; height: 1rem; flex: none; color: var(--ink-3); background: currentColor; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 18 6-6-6-6'/%3E%3C/svg%3E") center / contain no-repeat; transition: transform .15s; }
.block-collapsible > details[open] > summary::before { transform: rotate(90deg); }
.block-collapsible > details[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.block-collapsible > details > summary:hover { background: var(--surface-2); }
.block-collapsible > details > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.block-collapsible > details > summary :is(h2, h3) { flex: none; }
.block-collapsible > details > summary span { min-width: 0; color: var(--ink-2); font-size: .8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.block-collapsible > details > .block-fields { padding: .8rem .9rem; border-top: 1px solid var(--line); }
.block-collapsible > .tools { position: absolute; z-index: 1; top: .6rem; right: .7rem; }
.blocks-field > .block.nested { background: var(--surface-2); box-shadow: none; margin-bottom: .5rem; }
.nested-collapsible > details > summary { min-height: 2.4rem; background: var(--surface); }
.nested-collapsible > details > summary :is(h2, h3) { font-size: .85rem; }
.nested-collapsible > details > .block-fields { padding: .7rem .8rem; }
.nested-empty { margin: 0 0 .75rem; color: var(--ink-2); font-size: .875rem; }
.nested-add { background: var(--surface-2); }
.add-block { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; border: 1px dashed var(--line-2); border-radius: var(--radius); padding: .85rem 1rem; margin-top: .25rem; }
.add-block .field { margin: 0; flex: 1 1 12rem; }
@media (max-width: 42rem) {
  .block-collapsible > details > summary { align-items: flex-start; flex-wrap: wrap; padding-right: 1rem; }
  .block-collapsible > details > summary span { flex-basis: calc(100% - 2rem); margin-left: 1.7rem; margin-top: -.45rem; }
  .block-collapsible > .tools { position: relative; top: auto; right: auto; padding: .55rem .9rem; border-top: 1px solid var(--line); }
  .block .tools button, .block-remove-confirm > summary { min-height: 2.5rem; min-width: 2.5rem; }
  .block-remove-panel { left: 1rem; right: 1rem; width: auto; max-width: none; }
}

/* Danger zone reads as a boundary, not as one more section. */
.danger-zone { border: 1px solid var(--line); border-radius: var(--radius); padding: .9rem 1.1rem; margin-top: 2.5rem; background: var(--surface); }
.danger-zone h2 { margin: 0 0 .3rem; font-size: .95rem; color: var(--danger); }
.danger-zone p { margin: 0 0 .8rem; font-size: .88rem; color: var(--ink-2); overflow-wrap: anywhere; }
.danger-zone form { margin: 0; }
.danger-confirm > summary, .inline-confirm > summary { width: max-content; color: var(--danger); cursor: pointer; font-weight: 600; font-size: .85rem; text-decoration: underline; text-underline-offset: .2em; }
.danger-confirm[open] > summary, .inline-confirm[open] > summary { margin-bottom: .75rem; }
.danger-confirm p { max-width: 55ch; }
.inline-confirm { align-self: center; }
.inline-confirm form { margin: 0; }

/* Data. */
.badge { display: inline-block; padding: .05rem .5rem; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-size: .68rem; font-weight: 700; line-height: 1.6; letter-spacing: .04em; text-transform: uppercase; vertical-align: middle; }
.tag { display: inline-block; padding: .05rem .5rem; border-radius: 999px; background: var(--surface-2); color: var(--ink-2); font: 600 .7rem/1.6 var(--mono); letter-spacing: .02em; vertical-align: middle; }
dl.entry { margin: .7rem 0 0; display: grid; grid-template-columns: minmax(5rem, 9rem) 1fr; gap: .3rem .9rem; font-size: .9rem; }
@media (max-width: 42rem) { dl.entry { grid-template-columns: minmax(0, 1fr); gap: 0; } dl.entry dd { margin-bottom: .5rem; } }
dl.entry dt { font-weight: 600; color: var(--ink-2); }
dl.entry dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: .88rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
th, td { text-align: left; padding: .6rem .9rem; border-bottom: 1px solid var(--line); }
th { font-size: .68rem; font-weight: 650; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-3); background: var(--surface-2); }
tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: color-mix(in srgb, var(--surface-2) 55%, transparent); }
td time { color: var(--ink-2); }
code { font-family: var(--mono); font-size: .86em; }
:not(pre) > code { white-space: normal; overflow-wrap: anywhere; }
pre { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: .9rem 1rem; overflow-x: auto; font-size: .82rem; line-height: 1.55; }
pre code { font-family: var(--mono); }

/* Inbox. */
.filter-bar { display: flex; flex-wrap: wrap; align-items: end; gap: .75rem 1rem; margin: 0 0 1.25rem; padding: .8rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.filter-bar .field { margin: 0; flex: 0 1 16rem; }
.filter-bar .checkbox { flex: none; align-self: center; margin: 1.4rem 0 0; }
.submission h2 { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem; }
.submission.read { box-shadow: none; background: transparent; }
.submission.read h2 { font-weight: 600; color: var(--ink-2); }
.submission.unread { border-left: 3px solid var(--accent); }
.small { font-size: .8rem; }
.spam-note { margin: .4rem 0 0; color: var(--danger) !important; }
.actions.compact { margin-top: .9rem; padding-top: .75rem; border-top: 1px solid var(--line); }
.actions.compact button { min-height: 2.1rem; padding: .3rem .75rem; font-size: .82rem; }
@media (max-width: 42rem) { .filter-bar .checkbox { margin-top: 0; } }

/* Signed-out screens: one card, centred, nothing else to look at. */
.sign-in-card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 1.75rem 1.75rem 1.6rem; box-shadow: var(--shadow); }
.sign-in-card .brand { color: var(--ink); padding: 0 0 1.1rem; margin: 0 0 1.25rem; }
.sign-in-card .brand .mark { width: 2.25rem; height: 2.25rem; border-radius: 9px; }
.sign-in-card h1 { font-size: 1.3rem; }
.sign-in-card .lede { margin-bottom: 1.25rem; }
.sign-in-card .actions { margin-top: 1.1rem; }
.sign-in-card button { width: 100%; }
body.plain .flash { margin-bottom: 1rem; }

/* Visual editor. */
.editor { border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--surface); overflow: hidden; }
.editor:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
.editor-toolbar { display: flex; flex-wrap: wrap; gap: .1rem; padding: .3rem .4rem; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.editor-toolbar button { min-height: 1.7rem; min-width: 1.7rem; padding: 0; background: transparent; color: var(--ink-2); border: 1px solid transparent; border-radius: 5px; }
.editor-toolbar button svg { width: .95rem; height: .95rem; }
.editor-toolbar button:hover { background: var(--surface); border-color: var(--line-2); color: var(--ink); }
.editor-toolbar button[aria-pressed="true"] { background: var(--ink); color: var(--canvas); border-color: var(--ink); }
.editor-toolbar button:nth-child(3), .editor-toolbar button:nth-child(6), .editor-toolbar button:nth-child(8) { margin-left: .45rem; position: relative; }
.editor-toolbar button:nth-child(3)::before, .editor-toolbar button:nth-child(6)::before, .editor-toolbar button:nth-child(8)::before { content: ""; position: absolute; left: -.3rem; top: .35rem; bottom: .35rem; width: 1px; background: var(--line-2); }
.editor-surface .ProseMirror { font-size: .875rem; }
.editor-surface .ProseMirror { min-height: 9rem; padding: .7rem .8rem; outline: none; font-family: var(--sans); }
.editor-surface .ProseMirror > :first-child { margin-top: 0; }
.editor-surface .ProseMirror :is(h2, h3) { margin: 1.2rem 0 .4rem; }
.editor-surface .ProseMirror blockquote { margin: .8rem 0; padding-left: .9rem; border-left: 3px solid var(--line-2); color: var(--ink-2); }
.editor-surface .ProseMirror code { font-family: var(--mono); font-size: .9em; background: var(--surface-2); padding: .05em .3em; border-radius: 3px; }
.error-text { color: var(--danger); font-size: .85rem; margin: .3rem 0 0; font-weight: 600; }

/* Present to assistive technology, absent visually — never display:none, which removes it from the accessibility tree. */
.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
/* Motion: page changes keep the chrome and the preview in place while the content settles; sections open smoothly; a flash slides in. */
@media (prefers-reduced-motion: no-preference) {
  @view-transition { navigation: auto; }
  .sidebar { view-transition-name: sidebar; }
  .crumbs { view-transition-name: crumbs; }
  .live { view-transition-name: live; }
  ::view-transition-old(root) { animation: fade-out 140ms ease-out both; }
  ::view-transition-new(root) { animation: settle 320ms cubic-bezier(.2,.65,.3,1) both; }
  ::view-transition-group(live), ::view-transition-group(sidebar), ::view-transition-group(crumbs) { animation-duration: 0s; }
  .flash { animation: settle 420ms cubic-bezier(.2,.65,.3,1) both; }
  .block-collapsible > details[open] > .block-fields { animation: appear 300ms ease-out both; }
  .live-frame { transition: width .45s cubic-bezier(.32,.72,0,1), border-radius .45s cubic-bezier(.32,.72,0,1); }
  .sidebar nav a, .count, .live-devices label { transition: background .35s cubic-bezier(.32,.72,0,1), color .35s cubic-bezier(.32,.72,0,1); }
  @keyframes settle { from { opacity: 0; transform: translateY(.5rem); } }
  @keyframes appear { from { opacity: 0; } }
  @keyframes fade-out { to { opacity: 0; } }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
`;

/** One stylesheet for every screen, served as a file rather than inlined into each page. */
export const STYLESHEET = STYLES;

/** Errors carry their remedy after `fix:`; on screen it reads better as a line of its own. */
function flashMessage(message: string) {
  const [headline, fix] = message.split(/\n\s*fix:\s*/, 2);
  return html`<p>${headline}</p>
    ${fix ? html`<p class="fix">${fix}</p>` : ""}`;
}
