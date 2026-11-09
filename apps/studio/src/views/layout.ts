/** Server-rendered HTML for the whole studio. */

import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { assetUrl } from "../assets.js";
import { icon } from "./icons.js";
import { personAvatar, siteAvatar } from "./pixel.js";
import { locale } from "./locale.js";
import { viewer } from "./viewer.js";
import { theme, type Theme } from "./theme.js";
import { chrome as shell } from "./chrome.js";

/** Display type the headings use: fetched with the stylesheet, so it is in hand before the first paint. */
const FONTS = ["space-grotesk-500.woff2", "space-grotesk-700.woff2"];

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
  section?: "sites" | "inbox" | "editors";
  /** Unread submissions, shown on the inbox link so it is worth glancing at. */
  unread?: number;
  /** Signed-out screens get the shell without the navigation. */
  chrome?: boolean;
  site?: SiteNav;
  /** Seconds before the page loads itself again, while it reports work still running. */
  refresh?: number;
}

/** Render-blocking in the head: an enhancement that lands after the first paint moves what it enhances. */
const script = (file: string) =>
  html`<script type="module" blocking="render" src="${assetUrl(file)}"></script>`;

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
    chrome = true,
    site,
    refresh,
  } = options;
  const unread = options.unread ?? shell().unread?.() ?? 0;
  const sidebar = chrome ? shell().sidebar : undefined;
  // Top-level screens name themselves, so the bar is there on every screen and nothing below it moves.
  const trail = crumbs.length > 0 ? crumbs : [{ href: "", label: title }];

  return compact(
    `<!doctype html>${html`
      <html lang="${locale()}" data-theme="${theme()}">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="theme-color" content="#f4f4f2" />
          <meta name="robots" content="noindex" />
          ${refresh ? html`<meta http-equiv="refresh" content="${refresh}" />` : ""}
          <title>${title} · GreatCMS Studio</title>
          <link rel="icon" href="/favicon.ico" sizes="32x32" />
          <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
          <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
          <link rel="stylesheet" href="${assetUrl("studio.css")}" />
          ${FONTS.map(
            (file) =>
              html`<link
                rel="preload"
                href="/assets/${file}"
                as="font"
                type="font/woff2"
                crossorigin
              />`,
          )}
          ${editor ? script("editor.js") : ""}
          ${liveSite ? html`${script("live.js")} ${script("form.js")} ${script("shell.js")}` : ""}
        </head>
        <body
          class="${chrome ? "" : "plain"}"
          ${sidebar ? raw(` style="--sidebar-width: ${sidebar}px"`) : ""}
        >
          <a class="skip-link" href="#main">Skip to content</a>

          ${chrome ? navigation(section, unread, site, liveSite) : ""}

          <div class="content">
            ${
              chrome
                ? html`
                    <nav aria-label="Breadcrumb" class="crumbs">
                      <ol>
                        ${trail.map(
                          (crumb, index) => html`
                            <li>
                              ${
                                index === trail.length - 1
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

            <main id="main">${flash ? flashNotice(flash) : ""} ${body}</main>
          </div>
        </body>
      </html>
    `}`,
  );
}

/** An editor's split at the width its preview was last dragged to, so it opens there. */
export function splitWidth() {
  const live = shell().live;
  return live ? raw(` style="--live-width: ${live}px"`) : "";
}

/** System, light or dark: three buttons in one form, so it works with no script at all. */
export function themeSwitch() {
  const choices: Array<{ value: Theme; icon: "monitor" | "sun" | "moon"; label: string }> = [
    { value: "system", icon: "monitor", label: "Match the system" },
    { value: "light", icon: "sun", label: "Light" },
    { value: "dark", icon: "moon", label: "Dark" },
  ];
  return html`<form method="POST" action="/theme" class="theme-switch" aria-label="Theme">
    ${choices.map(
      (choice) =>
        html`<button
          type="submit"
          name="theme"
          value="${choice.value}"
          title="${choice.label}"
          aria-pressed="${theme() === choice.value ? "true" : "false"}"
        >
          ${icon(choice.icon, choice.label)}
        </button>`,
    )}
  </form>`;
}

/** A result or an error, announced on arrival; a page may place it itself, as sign-in does. */
export function flashNotice(flash: NonNullable<PageOptions["flash"]>) {
  return html`
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
  `;
}

/**
 * Drops the templates' indentation, which is most of a large editor's bytes. Line breaks stay, so
 * the space between inline elements does too. Inside a textarea or a pre, whitespace is content,
 * so those are left exactly as they are.
 */
export function compact(markup: string): string {
  return markup
    .split(/(<(?:textarea|pre)\b[\s\S]*?<\/(?:textarea|pre)>)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/\n[ \t\n]*/g, "\n")))
    .join("");
}

/** The mark: a pixel G whose crossbar is a commit, the one thing a publish becomes. */
export function brandMark() {
  return raw(
    '<svg class="mark" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2.2" fill="#0e0f11"/><g shape-rendering="crispEdges"><path fill="#0b5c47" d="M3.25 1.75h5v1h-5zM2.25 2.75h2v1h-2zM2.25 3.75h2v1h-2zM2.25 4.75h2v1h-2zM5.25 4.75h3v1h-3zM2.25 5.75h2v1h-2zM6.25 5.75h2v1h-2zM2.25 6.75h2v1h-2zM6.25 6.75h2v1h-2zM3.25 7.75h5v1h-5z"/><path fill="#f3f3f3" d="M2.75 1.25h5v1h-5zM1.75 2.25h2v1h-2zM1.75 3.25h2v1h-2zM1.75 4.25h2v1h-2zM1.75 5.25h2v1h-2zM5.75 5.25h2v1h-2zM1.75 6.25h2v1h-2zM5.75 6.25h2v1h-2zM2.75 7.25h5v1h-5z"/><path fill="#1fbf8a" d="M4.75 4.25h3v1h-3z"/></g></svg>',
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
              aria-valuenow="${shell().sidebar ?? 248}"
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
                <form
                  method="GET"
                  action="/sites/${site.id}/search"
                  class="nav-search"
                  role="search"
                  aria-label="Search from the sidebar"
                >
                  <label class="visually-hidden" for="nav-q">Search ${site.name}</label>
                  ${icon("search")}
                  <input type="search" id="nav-q" name="q" placeholder="Search content" />
                </form>
                <p class="sidebar-label">Site</p>
                <ul>
                  <li>
                    <a
                      class="site-name"
                      href="/sites/${site.id}"
                      aria-current="${site.current === undefined && section === "sites" ? "page" : undefined}"
                      >${siteAvatar(site.id, "avatar small")} ${site.name}</a
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
                    <a
                      href="/sites/${site.id}/settings"
                      aria-current="${site.current === "settings" ? "page" : undefined}"
                      >${icon("settings")} Settings</a
                    >
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
        ${
          viewer()?.owner
            ? html`<a href="/editors" aria-current="${current("editors")}"
                >${icon("users")} <span class="label">Editors</span></a
              >`
            : ""
        }
        ${
          viewer() && !viewer()?.owner
            ? html`<p class="signed-in">${personAvatar(viewer()?.name ?? "")} ${viewer()?.name}</p>`
            : ""
        }
        <button class="link" type="submit">
          ${icon("signOut")} <span class="label">Sign out</span>
        </button>
      </form>
      ${themeSwitch()}
    </header>
  `;
}

/** The dark palette, once, for both ways of arriving at it. */
const DARK = `
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
    --code-tag: #43c99a;
    --code-attr: #b9a3f5;
    --code-value: #f0b36b;
    --shadow-lift: 0 2px 6px -2px rgba(0, 0, 0, .4);
`;

const STYLES = `
/* The same identity as the website: stone surfaces, tight near-black type, mono only for what is a file, one green for publishing. */
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 500; font-display: swap; src: url(/assets/space-grotesk-500.woff2) format("woff2"); }
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 700; font-display: swap; src: url(/assets/space-grotesk-700.woff2) format("woff2"); }
/* Arial sized to Space Grotesk's width and set on its baseline, so a late font swaps in without moving a line. */
@font-face { font-family: "Space Grotesk Fallback"; font-weight: 500; src: local("Arial"), local("ArialMT"), local("Liberation Sans"), local("LiberationSans"); size-adjust: 105.15%; ascent-override: 93.2%; descent-override: 27.6%; line-gap-override: 0%; }
@font-face { font-family: "Space Grotesk Fallback"; font-weight: 700; src: local("Arial Bold"), local("Arial-BoldMT"), local("Liberation Sans Bold"), local("LiberationSans-Bold"); size-adjust: 99.43%; ascent-override: 98.6%; descent-override: 29.2%; line-gap-override: 0%; }
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
  --display: "Space Grotesk", "Space Grotesk Fallback", var(--sans);
  --shadow: 0 1px 2px rgba(21, 23, 26, .04);
  /* Code in the brand's green, one cool and one warm hue beside it, each at least 4.5:1 on a surface. */
  --code-tag: #0d7a5f;
  --code-attr: #6a4bb8;
  --code-value: #9a5508;
  --shadow-lift: 0 2px 6px -2px rgba(21, 23, 26, .08);
  --pop: 0 8px 24px -12px rgba(0, 0, 0, .25);
}
/* Dark when chosen, or when the system is and nothing else was chosen. */
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; ${DARK} }
@media (prefers-color-scheme: dark) {
  :root[data-theme="system"] { ${DARK} }
}
*, *::before, *::after { box-sizing: border-box; }
/* The scrollbar's room is kept on every screen, so a short page sits where a long one does. */
html { scroll-padding-top: 5rem; scrollbar-gutter: stable; }
body {
  margin: 0;
  align-content: start;
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
  font-size: .92rem; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; line-height: 1.05;
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
.site-nav .site-name .avatar { box-shadow: none; }
.sign-out { margin-top: auto; padding: .75rem .1rem 0; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: .15rem; }
.sign-out > a { display: inline-flex; align-items: center; gap: .55rem; padding: .4rem .55rem; color: var(--ink-2); font-size: .88rem; text-decoration: none; border-radius: var(--radius-sm); }
.sign-out > a:hover { color: var(--ink); background: var(--surface-2); }
.sign-out > a[aria-current="page"] { color: var(--accent); background: var(--accent-soft); font-weight: 600; }
.sign-out > a[aria-current="page"] .icon { color: var(--accent); }
.sign-out > button { align-self: flex-start; }
.theme-switch { display: flex; gap: .15rem; margin: .35rem .1rem 0; padding: .2rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); width: max-content; }
.theme-switch button { display: grid; place-items: center; width: 1.9rem; height: 1.6rem; min-height: 0; padding: 0; border: 0; border-radius: 999px; background: transparent; color: var(--ink-3); }
.theme-switch button:hover { background: var(--surface); color: var(--ink); }
.theme-switch button[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-lift); }
.theme-switch .icon { width: .95rem; height: .95rem; }
.signed-in { display: flex; align-items: center; gap: .55rem; margin: 0 0 .2rem; padding: .2rem .55rem; font-size: .84rem; font-weight: 600; color: var(--ink); }
.signed-in .avatar { width: 1.5rem; height: 1.5rem; border-radius: 6px; }
.editors li > .avatar { width: 2.1rem; height: 2.1rem; border-radius: 8px; }
:is(.editors, .folders) { list-style: none; margin: 0 0 1.5rem; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
:is(.editors, .folders) li { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1.25rem; padding: .65rem .9rem; border-top: 1px solid var(--line); }
:is(.editors, .folders) li:first-child { border-top: 0; }
:is(.editors, .folders) li > div { display: flex; flex-direction: column; flex: 1 1 14rem; }
:is(.editors, .folders) li .muted { font-size: .8rem; }
.folders li > form { margin: 0; }
.notice.warn { margin: 0 0 .85rem; padding: .6rem .8rem; border: 1px solid var(--warn); border-radius: var(--radius-sm); background: var(--warn-bg); color: var(--ink); font-size: .85rem; }
.app-logo { display: flex; gap: .9rem; align-items: center; margin: 1rem 0; padding: .75rem .9rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.app-logo img { flex: none; border-radius: 12px; }
.app-logo p { margin: 0; font-size: .85rem; color: var(--ink-2); }
.connect-section { max-width: 44rem; margin: 0 0 2rem; }
.connect-section > h2, .connect-heading { font-size: 1rem; margin: 0 0 .35rem; }
.connect-section > p { color: var(--ink-2); font-size: .88rem; margin: 0 0 .85rem; }
.choice { display: flex; gap: .55rem; align-items: start; margin: 0 0 .55rem; }
.choice:last-child { margin-bottom: 0; }
.choice input { margin-top: .25rem; }
.choice label { font-weight: 600; font-size: .88rem; }
.choice .hint { margin-top: 0; }
.row-form { display: flex; gap: .4rem; align-items: center; }
.row-form input { min-width: 12rem; }
.card-form, .page-form, .page-form + .danger-zone { max-width: 44rem; }
.card-form { padding: .9rem 1rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.card-form h2 { margin: 0 0 .75rem; font-size: .95rem; }
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
  /* The site's map becomes one row that scrolls sideways, so the page starts on the first screen. */
  .site-nav {
    display: flex; align-items: center; gap: .25rem; padding: .35rem 0 0; border-top: 1px solid var(--line);
    overflow-x: auto; scrollbar-width: none; overscroll-behavior-x: contain;
  }
  .site-nav::-webkit-scrollbar { display: none; }
  .sidebar .site-nav ul { flex-wrap: nowrap; }
  .site-nav a { white-space: nowrap; }
  .site-nav .tree-label { padding: 0; }
  .site-nav .site-tools { margin: 0; padding: 0 0 0 .25rem; border-top: 0; border-left: 1px solid var(--line); }
  .sidebar .site-nav .nav-search { flex: 0 0 9.5rem; margin: 0; }
  .sign-out { margin: 0; padding: 0; border: 0; flex-direction: row; }
  .sidebar > .theme-switch { order: 2; margin: 0; }
  /* In a row a bolder current link would push its neighbours along. */
  .sidebar nav a[aria-current="page"], .sign-out > a[aria-current="page"] { font-weight: 500; }
}
/* A phone keeps the brand, the account links and the theme on one row: the links keep their names for screen readers. */
@media (max-width: 30rem) {
  .sign-out .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .sign-out > a, .sign-out > button { padding: .4rem; }
}

/* Content column. */
.content { display: flex; flex-direction: column; min-width: 0; }
.crumbs {
  position: sticky; top: 0; z-index: 6;
  padding: .7rem 2.25rem; border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--canvas) 86%, transparent); backdrop-filter: blur(12px);
}
/* One line whatever the trail: earlier steps give way first, so the bar is the same height on every screen. */
.crumbs ol { display: flex; align-items: center; gap: .5rem; list-style: none; margin: 0; padding: 0; font-size: .82rem; color: var(--ink-2); white-space: nowrap; }
.crumbs a { color: var(--ink-2); text-decoration: none; }
.crumbs a:hover { color: var(--ink); text-decoration: underline; }
.crumbs li { display: flex; align-items: center; gap: .5rem; min-width: 0; }
.crumbs li:last-child { flex: none; max-width: 100%; }
.crumbs li > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.crumbs li + li::before { content: ""; width: .85rem; height: .85rem; background: currentColor; opacity: .4; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 18 6-6-6-6'/%3E%3C/svg%3E") center / contain no-repeat; }
.crumbs [aria-current="page"] { color: var(--ink); font-weight: 600; }
/* Set from the left on every screen, the editors' wider one included, so the heading never moves. */
main { width: 100%; max-width: 66rem; margin: 0; padding: 2rem 2.25rem 6rem; }
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

/* Typography: Space Grotesk for what names a place, the system face for what is read and typed. */
h1 { font: 700 1.85rem/1.1 var(--display); margin: 0 0 .4rem; letter-spacing: -.03em; }
h2 { font: 700 1.08rem/1.3 var(--display); margin: 2.25rem 0 .75rem; letter-spacing: -.01em; }
h3 { font-size: .95rem; font-weight: 650; margin: 1.5rem 0 .5rem; letter-spacing: -.01em; }
.brand, .stamp, .sidebar-label { font-family: var(--display); }
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
.card { display: flex; flex-direction: column; }
.card p.card-meta { margin-top: auto; padding-top: .6rem; color: var(--ink-3); font-size: .78rem; }
.card p.card-meta:empty { display: none; }
.site-card { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .9rem; align-items: start; }
.site-card .path { margin: 0 0 .7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* A site's tile: its own favicon, or its initial in pixels. Cornered like an app icon. */
.avatar { display: block; flex: none; width: 2.6rem; height: 2.6rem; border-radius: 10px; box-shadow: 0 0 0 1px var(--line); }
.avatar.small { display: inline-block; width: 1.15rem; height: 1.15rem; border-radius: 4px; }
.avatar.large { width: 2.3rem; height: 2.3rem; border-radius: 9px; }
.site-title { display: flex; align-items: center; gap: .75rem; }
.status { display: inline-flex; align-items: center; gap: .4rem; flex: none; white-space: nowrap; max-width: 100%; color: var(--ink-2); font-weight: 600; font-size: .78rem; }
.status::before { content: ""; flex: none; width: .5rem; height: .5rem; border-radius: 50%; background: var(--line-2); }
.status-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.status.ready::before { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
.status.down { color: var(--warn); }
/* Above the card's own stretched link, so it opens the site rather than the card. */
a.status.open-site { position: relative; z-index: 1; color: var(--ink-2); text-decoration: none; border-radius: 999px; padding: .15rem .55rem .15rem .4rem; margin-left: -.4rem; }
a.status.open-site:hover { color: var(--ink); background: var(--surface-2); }
a.status.open-site:hover .status-text { text-decoration: underline; text-underline-offset: .2em; }
a.status.open-site svg { width: .85rem; height: .85rem; flex: none; }
.status.down::before { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-bg); }
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
  .card-topline:has(.status) { display: block; }
  .card-topline .status { margin-top: .3rem; }
  table { display: block; overflow-x: auto; white-space: nowrap; }
}

/* A collection: one row per entry, the title first, when it last changed at the end. */
.entry-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); overflow: hidden; }
.entry-list li + li { border-top: 1px solid var(--line); }
.entry-list a { display: grid; grid-template-columns: minmax(10rem, 16rem) minmax(0, 1fr) auto; align-items: baseline; gap: .25rem 1.25rem; padding: .7rem 1rem; color: inherit; text-decoration: none; }
.entry-list a:hover { background: var(--surface-2); }
.entry-list a:hover strong { color: var(--accent); }
.entry-list strong { font-weight: 650; font-size: .9rem; }
.entry-list .summary { color: var(--ink-2); font-size: .84rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.entry-list .entry-meta { color: var(--ink-3); font-size: .78rem; white-space: nowrap; }
.entry-list .entry-meta code { font-size: .74rem; }
@media (max-width: 42rem) {
  .entry-list a { grid-template-columns: minmax(0, 1fr); }
  .entry-list .summary:empty { display: none; }
}

/* Recent changes: one commit per row, what it touched beneath. */
.activity { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); }
.activity > li { padding: .7rem 1.1rem; }
.activity > li + li { border-top: 1px solid var(--line); }
.activity-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .15rem 1rem; }
.activity-head strong { min-width: 0; font-weight: 600; font-size: .88rem; overflow-wrap: anywhere; }
.activity-head .muted { font-size: .78rem; white-space: nowrap; }
.activity-head code { font-size: .74rem; }
.touched { display: flex; flex-wrap: wrap; gap: .1rem 1rem; list-style: none; margin: .25rem 0 0; padding: 0; font-size: .82rem; }
.touched a { color: var(--accent); text-decoration: none; }
.touched a:hover { text-decoration: underline; }

/* Empty states earn their space: say what to do, not just that there is nothing. */
.empty {
  border: 1px dashed var(--line-2); border-radius: var(--radius);
  padding: 2.5rem 1.5rem; text-align: center; background: var(--surface);
}
.empty h2 { margin: 0 0 .35rem; font-size: 1.05rem; }
.empty p { margin: 0 auto 1.1rem; color: var(--ink-2); max-width: 38ch; }
.empty p:last-child { margin-bottom: 0; }
.empty.compact { max-width: 44rem; padding: 1.5rem; margin: 0 0 1.25rem; }

/* Forms. */
fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: .75rem .9rem .85rem; margin: 0 0 .85rem; background: var(--surface); min-width: 0; box-shadow: var(--shadow); }
/* The legend sits inside the box as its heading, not astride the border. */
legend { float: left; width: 100%; padding: 0; margin: 0 0 .55rem; font-weight: 650; font-size: .86rem; color: var(--ink); letter-spacing: -.01em; }
legend + * { clear: both; }
fieldset > legend + .hint { margin-top: -.35rem; margin-bottom: .85rem; }
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
input[type=text], input[type=url], input[type=number], input[type=date], input[type=datetime-local], input[type=password], input[type=email], input[type=search], textarea, select {
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
/* A multiple choice: each option a chip that fills when ticked. */
fieldset.choices { border: 0; padding: 0; margin: 0 0 .85rem; background: transparent; box-shadow: none; }
fieldset.choices > legend { font-size: .8rem; font-weight: 600; margin-bottom: .4rem; }
.chips { display: flex; flex-wrap: wrap; gap: .35rem; }
.chip { display: inline-flex; align-items: center; gap: .4rem; margin: 0; padding: .3rem .7rem .3rem .55rem; border: 1px solid var(--line-2); border-radius: 999px; background: var(--surface); font-size: .82rem; font-weight: 500; cursor: pointer; transition: background .15s, border-color .15s; }
.chip:hover { border-color: var(--ink-3); }
.chip:has(input:checked) { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.chip:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
.chip input { margin: 0; }
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
main:has(> .split) { max-width: none; }
main:has(> .split) .page-head { margin-bottom: .75rem; }
@media (min-width: 72rem) {
  /* The handle's column is there before the script shows the handle, so the preview does not step aside for it. */
  .split { grid-template-columns: minmax(0, 1fr) .6rem minmax(20rem, var(--live-width, 46%)); gap: 1.25rem; }
  /* Placed by hand: a hidden handle takes no cell, and the preview must not slide into its column. */
  .split > form { grid-column: 1; grid-row: 1; }
  .split > .split-handle { grid-column: 2; grid-row: 1 / span 2; }
  .split > .live { grid-column: 3; grid-row: 1 / span 2; }
  .split > .danger-zone { grid-column: 1; grid-row: 2; }
  .split-handle:not([hidden]) { display: block; position: sticky; top: 3.5rem; height: calc(100vh - 4.5rem); }
  .live { position: sticky; top: 3.5rem; height: calc(100vh - 4.5rem); display: flex; flex-direction: column; }
  .live-stage { flex: 1 1 auto; min-height: 16rem; }
}
.live { padding: .5rem; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
.live-bar { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; margin: .1rem .35rem .55rem; }
.live-bar h2 { display: inline-flex; align-items: center; gap: .45rem; margin: 0; font-size: .84rem; font-weight: 650; letter-spacing: 0; }
.live-bar h2::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
.live-url { flex: 1 1 10rem; min-width: 0; padding: .2rem .6rem; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); font-family: var(--mono); font-size: .74rem; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The status changes as the page answers: two lines are kept for it, so the frame below never moves. */
.live-bar p { flex: 1 0 100%; order: 10; margin: .35rem 0 0; font-size: .76rem; color: var(--ink-3); max-width: none; min-height: 3.1em; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.live-tools { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: .35rem; margin-left: auto; min-width: 0; }
.live-toggle { display: inline-flex; align-items: center; gap: .3rem; min-height: 1.9rem; margin: 0; padding: 0 .55rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); color: var(--ink-2); font-size: .74rem; font-weight: 600; cursor: pointer; user-select: none; }
.live-toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
.live-toggle .icon { width: .95rem; height: .95rem; }
.live-toggle:hover { color: var(--ink); }
.live-toggle:has(input:checked) { background: var(--accent); color: #fff; border-color: var(--accent); }
.live-toggle:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 1px; }
/* The controls the script turns on keep their places until it does, for browsers that paint before it runs. */
@media (scripting: enabled) {
  .live-tools > .live-toggle[hidden] { display: inline-flex !important; visibility: hidden; }
  .live-tools > .icon-button[hidden] { display: inline-grid !important; visibility: hidden; }
}
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
/* The dev server did not answer: say so over the frame, which stays in case the browser can reach it. */
.live-stage.is-down { position: relative; }
.live-down { position: absolute; inset: 0; z-index: 1; display: grid; place-content: center; justify-items: center; gap: .35rem; padding: 2rem; text-align: center; background: var(--surface-2); color: var(--ink-2); }
.live-down .icon { width: 1.75rem; height: 1.75rem; color: var(--warn); margin-bottom: .25rem; }
.live-down p { margin: 0; max-width: 34ch; font-size: .88rem; }
.live-down strong { color: var(--ink); font-size: .95rem; }
.live-empty { display: grid; place-items: center; min-height: 14rem; padding: 2rem; text-align: center; color: var(--ink-2); background: var(--surface-2); border-radius: var(--radius-sm); }
.live-empty .icon { width: 1.75rem; height: 1.75rem; color: var(--ink-3); margin-bottom: .5rem; }
.live-empty p { margin: 0; font-size: .88rem; max-width: 30ch; }

/* Restored edits: the one thing an editor must not miss before pressing Publish. */
.draft-notice { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem 1rem; margin: 0 0 1.25rem; padding: .8rem 1rem; border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); border-radius: var(--radius); background: var(--warn-bg); color: var(--warn); }
.draft-notice > .icon { width: 1.1rem; height: 1.1rem; }
.live-site p { margin: .2rem 0; font-size: .88rem; }
.live-site .muted { font-size: .8rem; }
.live-note { padding: .45rem .7rem; border-radius: var(--radius-sm); background: var(--surface-2); color: var(--ink-2); }
.live-failed { margin: .5rem 0; padding: .55rem .75rem; border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); border-radius: var(--radius-sm); background: var(--danger-bg); color: var(--danger); font-size: .85rem; }
.live-failed pre { max-height: 18rem; overflow: auto; margin: .5rem 0 0; font-size: .75rem; color: var(--ink); background: var(--surface); padding: .6rem; border-radius: var(--radius-sm); }
.live-rollback ul { list-style: none; margin: .4rem 0 0; padding: 0; }
.live-rollback li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .35rem 0; border-top: 1px solid var(--line); font-size: .84rem; }
.live-rollback form { margin: 0; }
.resource-heading h2 .icon { width: 1rem; height: 1rem; vertical-align: -.15em; }
.schedule { position: relative; margin-left: auto; }
.schedule > summary { display: inline-flex; align-items: center; gap: .35rem; min-height: 2.1rem; padding: 0 .6rem; border-radius: var(--radius-sm); color: var(--ink-2); font-size: .82rem; font-weight: 600; cursor: pointer; list-style: none; }
.schedule > summary::-webkit-details-marker { display: none; }
.schedule > summary:hover, .schedule[open] > summary { background: var(--surface-2); color: var(--ink); }
.schedule > summary .icon { width: .95rem; height: .95rem; }
.schedule-panel { position: absolute; right: 0; top: calc(100% + .35rem); z-index: 8; width: 17rem; padding: .75rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--pop); display: grid; gap: .45rem; }
.schedule-panel label { margin: 0; }
.scheduled ul { list-style: none; margin: 0; padding: 0; }
.scheduled li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .5rem 0; border-top: 1px solid var(--line); font-size: .86rem; }
.scheduled li > div { display: flex; flex-direction: column; min-width: 0; }
.scheduled li .muted { font-size: .78rem; }
.scheduled li.is-cancelled { opacity: .6; }
.scheduled form { margin: 0; }
.nav-search { position: relative; margin: 0 0 .75rem; }
.nav-search .icon { position: absolute; left: .55rem; top: 50%; translate: 0 -50%; width: .9rem; height: .9rem; color: var(--ink-3); pointer-events: none; }
.nav-search input { min-height: 1.95rem; padding: .25rem .5rem .25rem 1.8rem; font-size: .82rem; background: var(--surface-2); }
.search-form { display: flex; gap: .5rem; margin: 0 0 1rem; max-width: 36rem; }
.search-form input { flex: 1; }
.search-hits { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.search-hits li { border-top: 1px solid var(--line); }
.search-hits li:first-child { border-top: 0; }
.search-hits a { display: flex; flex-direction: column; gap: .15rem; padding: .6rem .9rem; color: var(--ink); text-decoration: none; }
.search-hits a:hover { background: var(--surface-2); }
.hit-place { font-size: .75rem; font-weight: 600; color: var(--ink-3); }
.hit-text { font-size: .86rem; }
.hit-text mark { background: var(--accent-soft); color: var(--ink); border-radius: 2px; padding: 0 .1em; }
.head-link { display: inline-flex; align-items: center; gap: .3rem; margin-left: .5rem; font-size: .82rem; white-space: nowrap; }
.head-link .icon { width: .95rem; height: .95rem; }
.history { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.history li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem 1rem; padding: .65rem .9rem; border-top: 1px solid var(--line); }
.history li:first-child { border-top: 0; }
.history li > div { display: flex; flex-direction: column; min-width: 0; }
.history .muted { font-size: .78rem; }
.history form { margin: 0; }
.presence-notice { display: flex; align-items: flex-start; gap: .6rem; margin: 0 0 1rem; padding: .7rem .9rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface-2); color: var(--ink-2); font-size: .85rem; }
.presence-notice p { margin: 0; }
.presence-notice > .icon { width: 1.05rem; height: 1.05rem; margin-top: .1rem; color: var(--accent); }
.draft-notice.is-stale { border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: var(--danger-bg); color: var(--danger); }
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
.block-collapsible > details > summary { display: flex; align-items: center; gap: .6rem; min-height: 2.7rem; padding: .5rem 10.5rem .5rem .8rem; cursor: pointer; list-style: none; border-radius: var(--radius); }
.block-collapsible > details > summary::-webkit-details-marker { display: none; }
.block-collapsible > details > summary::before { content: ""; width: 1rem; height: 1rem; flex: none; color: var(--ink-3); background: currentColor; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 18 6-6-6-6'/%3E%3C/svg%3E") center / contain no-repeat; transition: transform .15s; }
.block-collapsible > details[open] > summary::before { transform: rotate(90deg); }
.block-collapsible > details[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.block-collapsible > details > summary:hover { background: var(--surface-2); }
.block-collapsible > details > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.block-collapsible > details > summary :is(h2, h3) { flex: none; }
.block-collapsible > details > summary span { min-width: 0; color: var(--ink-2); font-size: .8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.block-collapsible > details > .block-fields { padding: .8rem .9rem; border-top: 1px solid var(--line); }
.block-collapsible > .tools { position: absolute; z-index: 1; top: .35rem; right: .6rem; }
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
.split > .danger-zone { margin-top: 0; }
.danger-confirm > summary, .inline-confirm > summary { width: max-content; color: var(--danger); cursor: pointer; font-weight: 600; font-size: .85rem; text-decoration: underline; text-underline-offset: .2em; list-style: none; }
.danger-confirm > summary::-webkit-details-marker, .inline-confirm > summary::-webkit-details-marker { display: none; }
.inline-confirm { display: flex; align-items: center; gap: .5rem; }
.inline-confirm > summary { padding: .45rem .75rem; border: 1px solid transparent; border-radius: var(--radius-sm); text-decoration: none; }
.inline-confirm > summary:hover, .inline-confirm[open] > summary { background: var(--danger-bg); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
.inline-confirm[open] > summary { margin-bottom: 0; }
.inline-confirm form { margin: 0; }
.danger-confirm[open] > summary, .inline-confirm[open] > summary { margin-bottom: .75rem; }
.danger-confirm p { max-width: 55ch; }
.inline-confirm { align-self: center; }
.inline-confirm form { margin: 0; }

/* Data. */
.badge { display: inline-block; padding: .05rem .5rem; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-size: .68rem; font-weight: 700; line-height: 1.6; letter-spacing: .04em; text-transform: uppercase; vertical-align: middle; }
.badge.warn { background: var(--warn-bg); color: var(--warn); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warn) 30%, transparent); letter-spacing: .02em; text-transform: none; font-weight: 650; font-size: .72rem; }
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
.code .tok-tag { color: var(--code-tag); }
.code .tok-attr { color: var(--code-attr); }
.code .tok-value { color: var(--code-value); }
.code .tok-punct { color: var(--ink-3); }

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

/* Signing in: the studio's name in pixels on the dark half, the one form on the other. */
body.plain:has(.sign-in) main { max-width: none; padding: 0; }
.sign-in { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); min-height: 100vh; }
.sign-in-art {
  position: relative; isolation: isolate; overflow: hidden;
  display: flex; flex-direction: column; justify-content: space-between; gap: 2.5rem;
  padding: 1.75rem clamp(1.5rem, 4vw, 3.5rem) 2rem; background: #0e0f11; color: #f3f3f3;
}
/* A grid of faint dots, the ground the letters are set on, fading towards the form. */
.sign-in-art::before {
  content: ""; position: absolute; inset: 0; z-index: -1;
  background: radial-gradient(rgba(255, 255, 255, .09) 1px, transparent 1.4px) 0 0 / 14px 14px;
  mask: linear-gradient(115deg, #000 20%, transparent 85%);
}
.sign-in-art .brand { padding: 0; border: 0; color: inherit; }
.sign-in-art .brand small { color: #8f959d; }
.sign-in-art .brand .mark { width: 2rem; height: 2rem; border-radius: 8px; box-shadow: 0 0 0 1px rgba(255, 255, 255, .14); }
.sign-in-word { max-width: 36rem; }
.pixel-word { display: block; width: 100%; height: auto; }
.sign-in-word p { margin: 1.75rem 0 0; max-width: 30ch; font: 500 clamp(1.05rem, .92rem + .45vw, 1.3rem)/1.45 var(--display); letter-spacing: -.01em; color: #c3c7cc; }
/* Squares on a hairline, every eighth one green: a row of commits. */
.pixel-rule {
  height: 4px; margin: 0; max-width: none;
  background:
    linear-gradient(90deg, #1fbf8a 4px, transparent 0) 0 0 / 64px 4px,
    linear-gradient(90deg, rgba(255, 255, 255, .22) 4px, transparent 0) 0 0 / 8px 4px;
}
.sign-in-form { display: grid; align-content: center; justify-items: center; padding: 3rem clamp(1.5rem, 6vw, 5rem); }
.sign-in-form > * { width: min(100%, 22rem); }
.sign-in-form .page-head { margin-bottom: 1.5rem; }
.sign-in-form h1 { font-size: 2rem; }
.sign-in-form input[type=password], .sign-in-form input[type=email] { min-height: 2.75rem; font-size: .95rem; }
.sign-in-form .actions { margin-top: 1.25rem; }
.sign-in-form .actions button { width: 100%; min-height: 2.75rem; font-size: .9rem; }
.sign-in-form > .theme-switch { width: max-content; margin: 2.5rem auto 0; }
@media (max-width: 52rem) {
  .sign-in { grid-template-columns: minmax(0, 1fr); min-height: 0; }
  .sign-in-art { gap: 1.5rem; padding: 1.1rem 1.25rem 1.25rem; }
  .sign-in-word .pixel-word { max-width: 17rem; }
  .sign-in-word p { margin-top: 1rem; font-size: 1rem; }
  .sign-in-form { justify-items: stretch; padding: 2rem 1.25rem 3rem; }
  .sign-in-form > * { width: auto; }
}
@media (prefers-reduced-motion: no-preference) {
  /* The letters lift off their shadow once, as the page arrives. */
  .pixel-word .face { animation: lift .7s cubic-bezier(.2, .7, .2, 1) .1s both; }
  @keyframes lift { from { transform: translate(3px, 3px); } }
}
body.plain .flash { margin-bottom: 1rem; }

/* Visual editor. */
/* The editor opens at the height of the textarea it replaces. */
textarea[data-richtext] { height: 15rem; }
.editor { display: flex; flex-direction: column; min-height: 15rem; border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--surface); overflow: hidden; }
.editor-surface { flex: 1 1 auto; display: flex; flex-direction: column; }
.editor-surface .ProseMirror { flex: 1 1 auto; }
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

/* Present to assistive technology, absent visually: never display:none, which removes it from the accessibility tree. */
.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
/*
 * Motion, only on opacity and transform so it never moves the layout. Between screens the chrome and
 * the preview hold their place, what changed in them crossfades, and the page settles in beneath.
 */
@media (prefers-reduced-motion: no-preference) {
  @view-transition { navigation: auto; }
  .sidebar { view-transition-name: sidebar; }
  .crumbs { view-transition-name: crumbs; }
  .live { view-transition-name: live; }
  ::view-transition-old(root) { animation: fade-out 140ms ease-out both; }
  ::view-transition-new(root) { animation: settle 320ms cubic-bezier(.2,.65,.3,1) both; }
  ::view-transition-group(live), ::view-transition-group(sidebar), ::view-transition-group(crumbs) { animation-duration: 0s; }
  ::view-transition-old(sidebar), ::view-transition-new(sidebar), ::view-transition-old(crumbs), ::view-transition-new(crumbs) { animation-duration: 180ms; animation-timing-function: ease-out; }
  .flash { animation: settle 420ms cubic-bezier(.2,.65,.3,1) both; }
  .block-collapsible > details[open] > .block-fields { animation: appear 300ms ease-out both; }
  /* A confirmation fades in beside the summary that asked for it. */
  :is(.inline-confirm, .danger-confirm)[open] > :not(summary) { animation: appear 200ms ease-out backwards; }
  .live-frame { transition: width .45s cubic-bezier(.32,.72,0,1), border-radius .45s cubic-bezier(.32,.72,0,1); }
  .sidebar nav a, .count, .live-devices label { transition: background .35s cubic-bezier(.32,.72,0,1), color .35s cubic-bezier(.32,.72,0,1); }
  :is(.crumbs a, .theme-switch button, .icon-button, .live-toggle, .sign-out > a, .sidebar button.link, .card-action, a.status.open-site, .entry-list a, .search-hits a, .outline a, .touched a, .block-collapsible > details > summary, :is(.schedule, .inline-confirm, .block-remove-confirm) > summary) { transition: background-color .2s ease-out, color .2s ease-out, border-color .2s ease-out, box-shadow .2s ease-out, transform .2s ease-out; }
  :is(.entry-list a, .search-hits a) strong { transition: color .2s ease-out; }
  tbody td { transition: background-color .2s ease-out; }
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
