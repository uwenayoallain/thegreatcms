# Hearth: a bakery on Next.js

[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](https://github.com/uwenayoallain/thegreatcms#ai-assistance "Built with an AI coding assistant and reviewed by a human")

A neighbourhood bakery's whole site, on Next.js 16 with the App Router. The
notice bar, hero, story, opening hours and menu are all content files in this
folder. Server Components read them through `@greatcms/reader`,
`output: "export"` writes every page as HTML, and a step after the build takes
out the JavaScript those pages have no use for.

```sh
pnpm dev                                           # from the repo root: studio + every example
pnpm --filter @greatcms/example-bakery-next dev    # this site alone, on next dev
pnpm --filter @greatcms/example-bakery-next build  # then `test`
```

## Where things are

| Path                    | What it holds                                                         |
| ----------------------- | --------------------------------------------------------------------- |
| `.cms/schema.yaml`      | Four regions and the `menu` collection                                |
| `content/cms/*.json`    | Identity and notice, hero, story, opening hours                       |
| `content/menu/*.json`   | One file per item: category, price, dietary tags, whether it features |
| `lib/cms.ts`            | The one place content is read, typed for the pages                    |
| `app/layout.tsx`        | The page shell, and the studio's preview script under `next dev`      |
| `app/page.tsx`, `menu/` | The pages, as Server Components                                       |
| `app/site.css`          | One stylesheet, which Next.js bundles and minifies                    |
| `scripts/strip-runtime` | The step after `next build` that takes the runtime out of the export  |

## How Next.js meets GreatCMS

- **Read on the server.** `content()` in `lib/cms.ts` creates a reader and
  resolves every region and the menu. Only Server Components call it, so the
  filesystem is never touched in the browser and no content is fetched at
  runtime.
- **Drafts in development only.** `next dev` renders on every request, and
  there the reader prefers the studio's unsaved edits in `.cms/draft/`. A
  build never reads them.
- **The preview, in development only.** The layout adds the reader's preview
  script under `next dev`, so the studio can point at what it is editing. Next
  does not watch content files, so the page carries `data-greatcms-unwatched`
  and the studio reloads it after each draft.
- **Forms without a service.** The pre-order form posts to the studio's inbox.
  Its items are a checkbox group under one name, and the inbox keeps every box
  that was ticked.

## What the export ships, and why

No page here has a client component: every link is a plain anchor, the order
form posts natively, and the motion is CSS. Next.js still gives each exported
page its runtime: React, the router, and a copy of the page as data for the
router to read. Next.js 16 has no supported switch for leaving them out of an
App Router export (`unstable_runtimeJS` was for the Pages Router). So
`pnpm build` is `next build && node scripts/strip-runtime.mjs`, and the second
half:

- removes the runtime's `<script>` tags and script preloads from every page,
  and keeps the structured data (`application/ld+json`);
- deletes the chunks and the router's `.txt` payloads, which nothing refers to
  any more;
- **fails the build, changing nothing**, if a page references a client
  component (yours, or one from a package, `next/link` and `next/script`
  included), carries an inline script it does not recognise, or loads a script
  from anywhere but Next.js's own chunks. The message names the page and the
  component.

The home page, cold, on a throttled phone profile (1.6 Mbps, 150 ms round
trip, CPU slowed four times, text gzipped, median of five loads in Chromium):

|                          | With the runtime | Without it |
| ------------------------ | ---------------- | ---------- |
| Requests                 | 10               | 5          |
| Bytes, uncompressed      | 521.7 KB         | 45.0 KB    |
| Bytes over the wire      | 168.8 KB         | 29.4 KB    |
| Largest contentful paint | 584 ms           | 516 ms     |
| Total blocking time      | 69 ms            | 0 ms       |
| Load event               | 1391 ms          | 382 ms     |

`next dev` is untouched: the step runs only after a build, so hot reload, the
studio's live preview and its inspector work as before.

**When you add a client component**, the build stops and says so. Make the
`build` script in `package.json` plain `next build` again, and in
`tests/site.test.ts` drop the checks under "the export" that expect no script
and raise the 50 KB page budget: the runtime is about 450 KB before
compression. The script-free checks in `tests/layout.test.ts` go with them.

## Budgets the tests hold

axe-clean pages, one `h1` each, nothing of the studio in an exported page, no
executable script and no JavaScript file anywhere in the export, every link,
anchor and asset resolving, one minified stylesheet, each page with all it
loads under 50 KB before compression, every menu item priced and grouped in
the schema's order, and every form control labelled.

In Chromium, when one is installed, `tests/layout.test.ts` loads every page at
375, 768, 1024, 1280 and 1600 pixels wide and fails on any layout shift, or on
a masthead, main column or footer that sits differently from one page to the
next or across a click. It runs again with the font held back, where
`font-display: optional` must keep the fallback rather than reflow the page.
The same browser checks that no page asks for a script, that the scroll-driven
effects and the transition between pages still run, and that the order form
is held back by the browser's own validation and then posts.
