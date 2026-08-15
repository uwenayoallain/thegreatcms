/** Server-rendered HTML for the whole studio. */

import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export interface Crumb {
  href: string;
  label: string;
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
  } = options;

  return `<!doctype html>${html`
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>${title} — GreatCMS Studio</title>
        <style>
          ${raw(STYLES)}
        </style>
      </head>
      <body class="${chrome ? "" : "plain"}">
        <a class="skip-link" href="#main">Skip to content</a>

        ${chrome ? navigation(section, unread) : ""}

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
                      <p>${flash.message}</p>
                      ${
                        flash.detail && flash.detail.length > 0
                          ? html`<ul>
                              ${flash.detail.map((line) => html`<li>${line}</li>`)}
                            </ul>`
                          : ""
                      }
                    </div>
                  `
                : ""
            }
            ${body}
          </main>
        </div>

        ${editor ? html`<script type="module" src="/assets/editor.js"></script>` : ""}
        ${liveSite ? html`<script type="module" src="/assets/live.js"></script>` : ""}
      </body>
    </html>
  `}`;
}

/** The one place every screen is reachable from, so no page is a dead end. */
function navigation(section: PageOptions["section"], unread: number) {
  const current = (name: PageOptions["section"]) => (section === name ? "page" : undefined);

  return html`
    <header class="sidebar">
      <a class="brand" href="/">
        <span class="brand-mark" aria-hidden="true">◆</span>
        GreatCMS
      </a>
      <nav aria-label="Sections">
        <ul>
          <li>
            <a href="/" aria-current="${current("sites")}">
              <span class="nav-icon" aria-hidden="true">▤</span>
              Sites
            </a>
          </li>
          <li>
            <a href="/inbox" aria-current="${current("inbox")}">
              <span class="nav-icon" aria-hidden="true">✉</span>
              Inbox ${unread > 0 ? html`<span class="count">${unread} unread</span>` : ""}
            </a>
          </li>
        </ul>
      </nav>
      <form method="POST" action="/sign-out" class="sign-out">
        <button class="link" type="submit">Sign out</button>
      </form>
    </header>
  `;
}

const STYLES = `
:root {
  color-scheme: light dark;
  --ink: #14161a;
  --ink-soft: #59606e;
  --paper: #f4f5f8;
  --raised: #ffffff;
  --sunken: #eceef3;
  --line: #dce0e8;
  --line-strong: #c2c8d4;
  --accent: #14563f;
  --accent-ink: #ffffff;
  --accent-soft: #e3f0ea;
  --danger: #a1160f;
  --danger-bg: #fdecea;
  --ok: #14532d;
  --ok-bg: #e7f6ec;
  --focus: #a34700;
  --radius: 12px;
  --radius-sm: 8px;
  --shadow: 0 1px 2px rgba(20, 22, 26, .06), 0 4px 12px rgba(20, 22, 26, .04);
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e8eaee;
    --ink-soft: #a2a9b6;
    --paper: #0f1115;
    --raised: #171a20;
    --sunken: #12141a;
    --line: #2a2f38;
    --line-strong: #3a414d;
    --accent: #5eead4;
    --accent-ink: #06231b;
    --accent-soft: #12302a;
    --danger: #ffb4ab;
    --danger-bg: #3b1512;
    --ok: #9ae0b0;
    --ok-bg: #16301f;
    --focus: #ffb066;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4);
  }
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr);
  min-height: 100vh;
}
body.plain { display: block; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 3px; }
.skip-link {
  position: absolute; left: .5rem; top: -3rem; z-index: 20;
  padding: .55rem 1rem; background: var(--accent); color: var(--accent-ink);
  border-radius: var(--radius-sm); text-decoration: none;
}
.skip-link:focus { top: .5rem; }

/* Navigation. */
.sidebar {
  background: var(--raised);
  border-right: 1px solid var(--line);
  padding: 1.1rem .85rem;
  display: flex; flex-direction: column; gap: 1.25rem;
}
.brand {
  display: flex; align-items: center; gap: .5rem;
  font-weight: 700; text-decoration: none; color: inherit;
  letter-spacing: -.02em; font-size: 1.05rem; padding: .2rem .5rem;
}
.brand-mark { color: var(--accent); font-size: .9em; }
.sidebar nav ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .15rem; }
.sidebar nav a {
  display: flex; align-items: center; gap: .6rem;
  padding: .5rem .6rem; border-radius: var(--radius-sm);
  text-decoration: none; color: var(--ink); font-weight: 500;
}
.sidebar nav a:hover { background: var(--sunken); }
.sidebar nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 650; }
.nav-icon { width: 1.1rem; text-align: center; color: var(--ink-soft); }
.sidebar nav a[aria-current="page"] .nav-icon { color: inherit; }
.count {
  margin-left: auto; font-size: .75rem; font-weight: 600;
  background: var(--accent); color: var(--accent-ink);
  padding: .05rem .45rem; border-radius: 999px;
}
@media (max-width: 52rem) {
  body { grid-template-columns: minmax(0, 1fr); }
  .sidebar {
    flex-direction: row; align-items: center; gap: 1rem;
    border-right: 0; border-bottom: 1px solid var(--line); padding: .6rem .9rem;
  }
  .sidebar nav { flex: 1; }
  .sidebar nav ul { display: flex; gap: .25rem; }
}

.sign-out { margin-top: auto; padding: .5rem .6rem; }
@media (max-width: 52rem) { .sign-out { margin: 0; } }

/* Content column. */
.content { display: flex; flex-direction: column; min-width: 0; }
.crumbs {
  padding: .7rem 1.5rem; border-bottom: 1px solid var(--line);
  background: var(--raised);
}
.crumbs ol { display: flex; flex-wrap: wrap; gap: .45rem; list-style: none; margin: 0; padding: 0; font-size: .875rem; color: var(--ink-soft); }
.crumbs a { color: var(--ink-soft); }
.crumbs li + li::before { content: "/"; margin-right: .45rem; color: var(--line-strong); }
.crumbs [aria-current="page"] { color: var(--ink); font-weight: 600; }
main { width: 100%; max-width: 60rem; margin: 0 auto; padding: 2rem 1.5rem 5rem; }
body.plain main { max-width: 24rem; margin: 0 auto; padding: 4rem 1.5rem; }

/* Typography. */
h1 { font-size: 1.75rem; margin: 0 0 .35rem; letter-spacing: -.025em; line-height: 1.2; }
h2 { font-size: 1.15rem; margin: 2.25rem 0 .75rem; letter-spacing: -.01em; }
h3 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
p { max-width: 64ch; }
a { color: inherit; }
.muted { color: var(--ink-soft); }
.lede { color: var(--ink-soft); margin: 0 0 1.75rem; font-size: .95rem; }
.page-head { margin-bottom: 2rem; }
.page-head .lede { margin-bottom: 0; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.section-head h2 { margin-bottom: .75rem; }

/* Flash. */
.flash { padding: .85rem 1rem; border-radius: var(--radius); margin-bottom: 1.75rem; border: 1px solid transparent; }
.flash p { margin: 0; font-weight: 600; max-width: none; }
.flash ul { margin: .5rem 0 0; padding-left: 1.1rem; font-weight: 400; }
.flash.success { background: var(--ok-bg); color: var(--ok); border-color: currentColor; }
.flash.error { background: var(--danger-bg); color: var(--danger); border-color: currentColor; }

/* Cards. */
.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: .6rem; }
.cards.two { grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr)); }
.card {
  background: var(--raised); border: 1px solid var(--line); border-radius: var(--radius);
  padding: .9rem 1.1rem; box-shadow: var(--shadow);
}
.card :is(h2, h3) { margin: 0 0 .15rem; font-size: 1rem; letter-spacing: 0; }
.card :is(h2, h3) a { text-decoration: none; }
.card :is(h2, h3) a:hover { text-decoration: underline; }
.card p { margin: 0; color: var(--ink-soft); font-size: .875rem; }
.card-link { display: block; text-decoration: none; }

/* Empty states earn their space: say what to do, not just that there is nothing. */
.empty {
  border: 1px dashed var(--line-strong); border-radius: var(--radius);
  padding: 2rem 1.5rem; text-align: center; background: var(--raised);
}
.empty h2 { margin: 0 0 .35rem; font-size: 1.05rem; }
.empty p { margin: 0 auto 1.1rem; color: var(--ink-soft); max-width: 38ch; }

/* Forms. */
fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem 1.15rem; margin: 0 0 1.25rem; background: var(--raised); }
legend { font-weight: 650; padding: 0 .4rem; }
.field { margin-bottom: 1.15rem; }
.field:last-child { margin-bottom: 0; }
label { display: block; font-weight: 600; margin-bottom: .3rem; }
.hint { display: block; font-weight: 400; font-size: .85rem; color: var(--ink-soft); margin-top: .15rem; }
input[type=text], input[type=url], input[type=number], input[type=date], input[type=password], input[type=email], textarea, select {
  width: 100%; padding: .55rem .7rem; font: inherit; color: inherit;
  background: var(--raised); border: 1px solid var(--line-strong); border-radius: var(--radius-sm);
}
input:focus, textarea:focus, select:focus { border-color: var(--accent); }
textarea { min-height: 7rem; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92rem; }
input[type=checkbox], input[type=radio] { width: 1.05rem; height: 1.05rem; accent-color: var(--accent); flex: none; }
.checkbox { display: flex; align-items: start; gap: .6rem; margin-bottom: .5rem; }
.checkbox label { margin: 0; font-weight: 500; }
.row { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
input[type=file] { width: 100%; font: inherit; color: inherit; padding: .4rem 0; }

/* Buttons. */
.actions { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-top: 1.5rem; }
button, .button {
  font: inherit; font-weight: 600; padding: .55rem 1.1rem; border-radius: var(--radius-sm);
  border: 1px solid transparent; background: var(--accent); color: var(--accent-ink);
  cursor: pointer; text-decoration: none; display: inline-block; line-height: 1.4;
}
button:hover, .button:hover { filter: brightness(1.08); }
/* A display rule beats the hidden attribute, so hidden has to say so louder. */
[hidden] { display: none !important; }
button.secondary, .button.secondary { background: var(--raised); color: var(--ink); border-color: var(--line-strong); }
button.secondary:hover, .button.secondary:hover { background: var(--sunken); filter: none; }
button.link { background: none; border: 0; padding: 0; color: var(--ink-soft); text-decoration: underline; font-weight: 500; cursor: pointer; }
button.link:hover { color: var(--ink); filter: none; }
button.danger { background: var(--raised); color: var(--danger); border-color: currentColor; }
button.danger:hover { background: var(--danger-bg); filter: none; }
button:disabled { opacity: .45; cursor: not-allowed; }

/*
 * The publish button sits at the end of a form that can run several screens
 * long, so it rides along instead of making you scroll to find it.
 */
.form-actions {
  position: sticky; bottom: 0; z-index: 5;
  display: flex; flex-wrap: wrap; gap: .6rem; align-items: center;
  margin: 1.75rem -1rem 0; padding: .85rem 1rem;
  background: var(--paper); border-top: 1px solid var(--line);
  box-shadow: 0 -8px 16px -8px rgba(20, 22, 26, .16);
}
@media (prefers-color-scheme: dark) {
  .form-actions { box-shadow: 0 -8px 16px -8px rgba(0, 0, 0, .6); }
}

/* The editor and the site beside it. */
.split { display: grid; gap: 2rem; align-items: start; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 72rem) {
  main { max-width: 84rem; }
  .split { grid-template-columns: minmax(0, 1fr) minmax(0, 24rem); }
}
.live { position: sticky; top: 1rem; }
.live-bar { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: .5rem; }
.live-bar h2 { margin: 0; font-size: .95rem; }
.live-bar p { margin: 0; font-size: .8rem; max-width: none; }
.live-frame { width: 100%; height: 30rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--raised); }
.live-frame.real { height: 26rem; }
.live-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
.live-actions form { margin: 0; }
.live .hint { margin-top: .6rem; }

/* The draft callout: loud enough to notice, calm enough not to look broken. */
.drafts { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: var(--radius); padding: 1rem 1.25rem; margin: 0 0 1.75rem; background: var(--raised); }
.drafts h2 { margin: 0 0 .35rem; font-size: 1rem; }
.drafts p { margin: 0; font-size: .9rem; color: var(--ink-soft); }
.drafts ul { margin: .6rem 0 0; padding-left: 1.1rem; }
.drafts code { font-size: .8rem; color: var(--ink-soft); }

/* Blocks. */
.block { border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem 1.15rem; margin-bottom: .85rem; background: var(--raised); box-shadow: var(--shadow); }
.block > header { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .9rem; padding-bottom: .6rem; border-bottom: 1px solid var(--line); }
.block :is(h2, h3) { margin: 0; font-size: .95rem; }
.block .tools { display: flex; gap: .3rem; }
.block .tools button { padding: .25rem .55rem; font-size: .8rem; background: transparent; color: var(--ink-soft); border-color: var(--line); }
.block .tools button:hover:not(:disabled) { background: var(--sunken); color: var(--ink); filter: none; }
.blocks-field > .block.nested { background: var(--sunken); box-shadow: none; margin-bottom: .6rem; }
.blocks-field > .block.nested > header { border-bottom: 0; margin-bottom: .5rem; padding-bottom: 0; }
.blocks-field > .block.nested > header .field { margin: 0; flex: 1; }
.add-block { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; border: 1px dashed var(--line-strong); border-radius: var(--radius); padding: .9rem 1.1rem; }
.add-block .field { margin: 0; flex: 1 1 12rem; }

/* Danger zone reads as a boundary, not as one more section. */
.danger-zone { border: 1px solid var(--danger); border-radius: var(--radius); padding: 1rem 1.15rem; margin-top: 2.5rem; background: var(--raised); }
.danger-zone h2 { margin: 0 0 .3rem; font-size: 1rem; color: var(--danger); }
.danger-zone p { margin: 0 0 .9rem; font-size: .9rem; color: var(--ink-soft); }
.danger-zone form { margin: 0; }

/* Data. */
.badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-size: .72rem; font-weight: 700; vertical-align: middle; }
.tag { display: inline-block; padding: .1rem .5rem; border-radius: 999px; background: var(--sunken); color: var(--ink-soft); font-size: .75rem; font-weight: 600; }
dl.entry { margin: .7rem 0 0; display: grid; grid-template-columns: minmax(6rem, 12rem) 1fr; gap: .3rem .9rem; font-size: .92rem; }
dl.entry dt { font-weight: 600; color: var(--ink-soft); }
dl.entry dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; background: var(--raised); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
th, td { text-align: left; padding: .55rem .8rem; border-bottom: 1px solid var(--line); }
th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-soft); background: var(--sunken); }
tr:last-child td { border-bottom: 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875em; }
pre { background: var(--sunken); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: .8rem .9rem; overflow-x: auto; font-size: .9rem; }
pre code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.preview-thumb { margin: 0 0 .8rem; }
.preview-thumb img { max-width: 10rem; height: auto; border-radius: var(--radius-sm); border: 1px solid var(--line); display: block; }
iframe.preview { width: 100%; height: 34rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--raised); }

/* Visual editor. */
.editor { border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--raised); overflow: hidden; }
.editor-toolbar { display: flex; flex-wrap: wrap; gap: .2rem; padding: .35rem; border-bottom: 1px solid var(--line); background: var(--sunken); }
.editor-toolbar button { padding: .25rem .6rem; min-width: 2.1rem; font-size: .85rem; font-weight: 600; background: transparent; color: var(--ink); border: 1px solid transparent; border-radius: 6px; }
.editor-toolbar button:hover { border-color: var(--line-strong); filter: none; }
.editor-toolbar button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.editor-surface .ProseMirror { min-height: 12rem; padding: .9rem 1rem; outline: none; }
.editor-surface .ProseMirror:focus-visible { outline: 3px solid var(--focus); outline-offset: -3px; }
.editor-surface .ProseMirror > :first-child { margin-top: 0; }
.editor-surface .ProseMirror :is(h2, h3) { margin: 1.2rem 0 .4rem; }
.editor-surface .ProseMirror blockquote { margin: .8rem 0; padding-left: .9rem; border-left: 3px solid var(--line-strong); color: var(--ink-soft); }
.editor-surface .ProseMirror code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; background: var(--sunken); padding: .05em .3em; border-radius: 4px; }
.error-text { color: var(--danger); font-size: .875rem; margin: .3rem 0 0; font-weight: 600; }

/* Present to assistive technology, absent visually — never display:none, which removes it from the. */
.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
`;
