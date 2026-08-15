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
}

export function page(
  options: PageOptions,
  body: HtmlEscapedString | Promise<HtmlEscapedString> | string,
): string {
  const { title, crumbs = [], flash, editor = false, liveSite = false } = options;

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
      <body>
        <a class="skip-link" href="#main">Skip to content</a>

        <header class="bar">
          <a class="brand" href="/">GreatCMS</a>
          <form method="POST" action="/sign-out">
            <button class="link" type="submit">Sign out</button>
          </form>
        </header>

        ${
          crumbs.length > 0
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
        ${editor ? html`<script type="module" src="/assets/editor.js"></script>` : ""}
        ${liveSite ? html`<script type="module" src="/assets/live.js"></script>` : ""}
      </body>
    </html>
  `}`;
}

const STYLES = `
:root {
  color-scheme: light dark;
  --ink: #16181d;
  --ink-soft: #545a63;
  --paper: #f7f6f4;
  --raised: #ffffff;
  --line: #d9d5ce;
  --accent: #1f4d3d;
  --accent-ink: #ffffff;
  --danger: #8c1d18;
  --danger-bg: #fbe9e7;
  --ok: #1c4b2a;
  --ok-bg: #e6f4ea;
  --focus: #a34700;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #ebe9e5;
    --ink-soft: #a9a49c;
    --paper: #15171b;
    --raised: #1d2026;
    --line: #333840;
    --accent: #7fd3b0;
    --accent-ink: #10201a;
    --danger: #ffb4ab;
    --danger-bg: #3b1512;
    --ok: #9ae0b0;
    --ok-bg: #16301f;
    --focus: #ffb066;
  }
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 3px; }
.skip-link {
  position: absolute; left: .5rem; top: -3rem; z-index: 5;
  padding: .55rem 1rem; background: var(--accent); color: var(--accent-ink);
  border-radius: var(--radius); text-decoration: none;
}
.skip-link:focus { top: .5rem; }
.bar {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: .85rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--raised);
}
.brand { font-weight: 700; text-decoration: none; color: inherit; letter-spacing: -.01em; }
.crumbs { padding: .75rem 1.25rem 0; }
.crumbs ol { display: flex; flex-wrap: wrap; gap: .5rem; list-style: none; margin: 0; padding: 0; font-size: .9rem; color: var(--ink-soft); }
.crumbs li + li::before { content: "/"; margin-right: .5rem; color: var(--line); }
.split { display: grid; gap: 1.75rem; align-items: start; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 68rem) { .split { grid-template-columns: minmax(0, 1fr) minmax(0, 26rem); } main { max-width: 84rem; } }
.live { position: sticky; top: 1rem; }
.live-bar { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: .5rem; }
.live-bar h2 { margin: 0; font-size: 1rem; }
.live-bar p { margin: 0; font-size: .8rem; }
.live-frame.real { height: 22rem; margin-bottom: 1.2rem; }
.live-frame { width: 100%; height: 30rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--raised); }
.live-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
.live-actions form { margin: 0; }
.drafts { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: var(--radius); padding: 1rem 1.25rem; margin: 1.5rem 0; background: var(--raised); }
.drafts h2 { margin-top: 0; font-size: 1rem; }
.drafts ul { margin: .5rem 0 0; padding-left: 1.1rem; }
.drafts code { font-size: .8rem; color: var(--ink-soft); }
main { max-width: 56rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
h1 { font-size: 1.6rem; margin: .25rem 0 1rem; letter-spacing: -.02em; }
h2 { font-size: 1.15rem; margin: 2rem 0 .75rem; }
p { max-width: 62ch; }
a { color: inherit; }
.muted { color: var(--ink-soft); }
.flash { padding: .85rem 1rem; border-radius: var(--radius); margin-bottom: 1.5rem; border: 1px solid transparent; }
.flash p { margin: 0; font-weight: 600; }
.flash ul { margin: .5rem 0 0; padding-left: 1.1rem; font-weight: 400; }
.flash.success { background: var(--ok-bg); color: var(--ok); border-color: currentColor; }
.flash.error { background: var(--danger-bg); color: var(--danger); border-color: currentColor; }
.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: .75rem; }
.card {
  background: var(--raised); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 1rem 1.15rem;
}
.card :is(h2, h3) { margin: 0 0 .2rem; font-size: 1.05rem; }
.card p { margin: 0; color: var(--ink-soft); font-size: .92rem; }
fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem 1.15rem; margin: 0 0 1.25rem; background: var(--raised); }
legend { font-weight: 700; padding: 0 .4rem; }
.field { margin-bottom: 1.1rem; }
.field:last-child { margin-bottom: 0; }
label { display: block; font-weight: 600; margin-bottom: .3rem; }
.hint { display: block; font-weight: 400; font-size: .85rem; color: var(--ink-soft); margin-top: .15rem; }
input[type=text], input[type=url], input[type=number], input[type=date], input[type=password], input[type=email], textarea, select {
  width: 100%; padding: .55rem .65rem; font: inherit; color: inherit;
  background: var(--paper); border: 1px solid var(--line); border-radius: 8px;
}
textarea { min-height: 7rem; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92rem; }
input[type=checkbox] { width: 1.1rem; height: 1.1rem; }
.checkbox { display: flex; align-items: center; gap: .55rem; }
.checkbox label { margin: 0; }
.row { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
.actions { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; margin-top: 1.5rem; }
button, .button {
  font: inherit; font-weight: 600; padding: .6rem 1.1rem; border-radius: 8px;
  border: 1px solid transparent; background: var(--accent); color: var(--accent-ink);
  cursor: pointer; text-decoration: none; display: inline-block;
}
/* A display rule beats the hidden attribute, so hidden has to say so louder. */
[hidden] { display: none !important; }
button.secondary, .button.secondary { background: transparent; color: inherit; border-color: var(--line); }
button.link { background: none; border: 0; padding: 0; color: inherit; text-decoration: underline; font-weight: 400; cursor: pointer; }
button.danger { background: transparent; color: var(--danger); border-color: currentColor; }
.block { border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem 1.15rem; margin-bottom: 1rem; background: var(--raised); }
.block header { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .85rem; }
.block :is(h2, h3) { margin: 0; font-size: 1rem; }
.block .tools { display: flex; gap: .4rem; }
.block .tools button { padding: .3rem .6rem; font-size: .85rem; background: transparent; color: inherit; border-color: var(--line); }
.badge { display: inline-block; padding: .1rem .45rem; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-size: .72rem; vertical-align: middle; }
dl.entry { margin: .6rem 0 0; display: grid; grid-template-columns: minmax(6rem, 12rem) 1fr; gap: .25rem .9rem; font-size: .93rem; }
dl.entry dt { font-weight: 600; color: var(--ink-soft); }
dl.entry dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.preview-thumb { margin: 0 0 .8rem; }
.preview-thumb img { max-width: 10rem; height: auto; border-radius: 8px; border: 1px solid var(--line); display: block; }
input[type=file] { width: 100%; font: inherit; color: inherit; padding: .4rem 0; }
pre { background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: .8rem .9rem; overflow-x: auto; font-size: .9rem; }
pre code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
h3 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
iframe.preview { width: 100%; height: 34rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--raised); }
table { width: 100%; border-collapse: collapse; font-size: .92rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
/* Visual editor. */
.editor { border: 1px solid var(--line); border-radius: 8px; background: var(--paper); overflow: hidden; }
.editor-toolbar { display: flex; flex-wrap: wrap; gap: .25rem; padding: .4rem; border-bottom: 1px solid var(--line); background: var(--raised); }
.editor-toolbar button { padding: .25rem .6rem; min-width: 2.1rem; font-size: .85rem; font-weight: 600; background: transparent; color: inherit; border: 1px solid transparent; border-radius: 6px; }
.editor-toolbar button:hover { border-color: var(--line); }
.editor-toolbar button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.editor-surface .ProseMirror { min-height: 12rem; padding: .9rem 1rem; outline: none; }
.editor-surface .ProseMirror:focus-visible { outline: 3px solid var(--focus); outline-offset: -3px; }
.editor-surface .ProseMirror > :first-child { margin-top: 0; }
.editor-surface .ProseMirror :is(h2, h3) { margin: 1.2rem 0 .4rem; }
.editor-surface .ProseMirror blockquote { margin: .8rem 0; padding-left: .9rem; border-left: 3px solid var(--line); color: var(--ink-soft); }
.editor-surface .ProseMirror code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; background: var(--paper-raised); padding: .05em .3em; border-radius: 4px; }
.error-text { color: var(--danger); font-size: .88rem; margin: .3rem 0 0; font-weight: 600; }
/* Present to assistive technology, absent visually — never display:none, which removes it from the. */
.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
`;
