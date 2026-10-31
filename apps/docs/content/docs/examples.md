---
title: The examples
summary: Five sites on Astro, Next.js, SvelteKit and Nuxt, and a Python reader, each built to prove one thing.
order: 70
---

Every example in the repository is also a test. They build in CI, run axe with
zero violations allowed, and assert that their output contains no script tag.

## A minimal site

```sh
pnpm --filter @greatcms/example-site-astro dev     # http://localhost:4321
```

`examples/site-astro` is the smallest honest demonstration. The home page puts a
managed hero next to a hand-written section, and both end up in the same static
HTML. A managed block list holds features and pull quotes an editor can
reorder. A blog collection is Markdown with frontmatter, which is what every
static site generator already expects. A contact form posts straight to the
studio with no JavaScript.

The about page is the interesting one: there is no `about.intro.json` in the
repository, so it renders the defaults declared in the schema. The page was
correct before the studio had ever been opened.

## A studio site with real motion

```sh
pnpm --filter @greatcms/example-studio-astro dev
```

`examples/studio-astro` is Paraline, a fictional design and motion studio, and
the showcase: the kind of site people assume needs a heavyweight CMS and a
JavaScript framework. Every word on it is managed: a studio identity, a hero
whose headline lines and rotating words are lists, a home page of reorderable
sections (client strip, selected work with two variants, a statement, services,
a process, numbers, a quote, a call to action), a contact page, and a JSON
collection of case studies whose covers are generated from a palette and a
motif chosen in the editor.

The motion is the site's own. Scroll-driven CSS does the reading-along
statement, the stacked services, the pinned sideways process, the counting
numbers and the case-study covers that morph into their page through
cross-document view transitions. A small script (under 8 KB compressed, using
Motion) adds what CSS cannot know, such as where the pointer is, and stands in
for scroll timelines where a browser lacks them. Everything stops for visitors
who ask for less motion, and the tests check that no animation starts outside
that preference.

`deploy/` beside it is the complete self-hosted stack for a site like this.

## A bakery on Next.js

```sh
pnpm --filter @greatcms/example-bakery-next dev
```

`examples/bakery-next` is Hearth, a neighbourhood bakery, on Next.js 16 with
the App Router. Server Components call the reader in `lib/cms.ts`, so content
is read on the server while the page renders and never reaches the browser as
a request. `output: "export"` writes every page as HTML, so any static host,
or `greatcms-deploy`, serves the folder as it is. The site has a notice bar an
editor can switch on for a holiday, opening hours as a list of groups, and a
`menu` collection with categories, prices and dietary tags, set like a printed
card. The pre-order form is a checkbox group that posts to the studio's inbox,
which keeps every box that was ticked.

`next dev` renders on every request, so the studio's drafts appear on the next
load. It does not watch content files, so the layout marks the page
`data-greatcms-unwatched` and the studio reloads the preview after each draft.
The preview script is added only under `next dev`. The tests check that an
exported page carries none of it, and keep the JavaScript Next.js brings under
a budget.

## A journal on SvelteKit

```sh
pnpm --filter @greatcms/example-journal-sveltekit dev
```

`examples/journal-sveltekit` is The Long Light, a writer's essays: a Markdown
collection with a date, a dek and tags, set in Newsreader and prerendered as
plain HTML. `csr = false` keeps SvelteKit's runtime off every page, the 404 is
a real prerendered route rather than the SPA fallback, and the reader's Vite
plugin reloads the page as the studio writes drafts. Its newsletter region has
no content file at all and renders the schema's defaults.

## A product changelog on Nuxt

```sh
pnpm --filter @greatcms/example-changelog-nuxt dev
```

`examples/changelog-nuxt` is Sundial, a product landing page and changelog on
Nuxt 4. A Nitro server route calls the reader in `server/api/cms.get.ts`, and
`nuxt generate` writes every page as static HTML with `noScripts: true` on
production routes so no client bundle ships. Releases are Markdown files with a
version, date and kind, and the beta waitlist form posts straight to the
studio's inbox.

## This site

`apps/docs` is the website you are reading. The landing page's headline, the
claims, and the closing note are JSON in the repository, edited in the studio.
The layout around them is ordinary Astro. The standard page renders `SPEC.md`
directly, so the published document and the one the code implements cannot
drift, and the docs pages are a Markdown collection like any blog.

## A reader in Python

`examples/reader-python/read.py` reads the standard without any of the
JavaScript packages and passes the conformance suite. See
[Any language](/docs/any-language/).

## Running any of them from the studio

Start the studio, add the example's folder as a site, and give it the dev
server's URL. Edits appear in your own dev server as you type, and publishing
commits to this repository like it would to yours.
