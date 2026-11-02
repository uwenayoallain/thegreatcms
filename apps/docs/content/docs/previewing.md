---
title: Previewing
summary: Your own dev server renders it. Never the studio.
order: 40
---

## In your own dev server

Point a local site at your dev server's URL and the editor shows your real
components beside the form. Publishing writes the files, your dev server
reloads, and the pane updates: usually within a couple of seconds.

It takes one dev-only line in your framework's config, and `greatcms init`
adds it for you:

| Framework        | One line                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Astro            | `astro.config`: `integrations: [greatcms()]` from `@greatcms/reader/astro`                                   |
| Next.js          | root layout: `<GreatcmsPreview />` inside `<head>`, from `@greatcms/reader/next`                             |
| Nuxt             | `nuxt.config`: `modules: ["@greatcms/reader/nuxt"]`                                                          |
| SvelteKit        | `vite.config`: `greatcmsWatch()` and `src/hooks.server`: `greatcmsHandle`, from `@greatcms/reader/sveltekit` |
| Other Vite sites | `vite.config`: `plugins: [greatcmsWatch()]` from `@greatcms/reader/vite`                                     |

The reader reads content with the filesystem, which is what keeps it
framework-neutral, and it also means a dev server has no idea those files are
dependencies. The Vite-based integrations watch them and reload the page.
`next dev` cannot be told about them, so the Next.js component asks the studio
to reload the frame after each edit instead.

Everything here runs only in development and only while the studio frames the
page. A built page carries none of it, and on your own tab nothing changes.

## As you type, in your own site

Connect a site as a folder on this machine, give it your dev server's URL, and
the editor shows that dev server beside the form. Each edit is written to
`.cms/draft/` in your working copy; your dev server notices and reloads, so your
own components render content nobody has published.

There is no approximation of your design, because there is no approximation: it
is your site. Publishing writes the real content file and clears the draft.

Three rules keep drafts safe. The reader only reads them when `NODE_ENV` is
`development`, so a build can never render one. `.cms/draft/` ignores itself, so
one can never be committed. And publishing clears the draft it came from, so the
site stops showing an edit that has already landed.

Without JavaScript nothing is written as you type, and the editor still
publishes: the frame simply shows the site as last published.

## Pointing at the page

The framed page knows what the form holds. Switch on **Select** above the
preview and the page is dissected: move over it and the heading, paragraph,
image or section under the pointer is outlined with its field's name; click,
and that field opens and takes focus in the form. **Sections** outlines every
block on the page at once, so a long page reads as the list of sections it is.
It runs the other way too: land in a field in the form and the page scrolls to
where it renders. The header and footer belong to site regions rather than to
the page, and they are on the page all the same: click the footer while editing
a page and the Footer editor opens at the field you clicked.

No markup is needed for this. The inspector matches each field's value to what
the page shows, which covers headings, copy, rich text and images. Where a site
transforms a value before printing it, or shows the same words twice, two
attributes make the match explicit:

```html
<h2 data-greatcms-field="blocks.0.title">{title}</h2>
<section data-greatcms-block="block-0">…</section>
```

The field path is the one the form uses, dotted; a block's id is `block-` and
its position. Both are plain attributes, so a built page keeps them and nothing
reads them there.

The inspector is part of the script the dev server injects while the page is
framed, so a visitor never downloads it and the studio never reaches into your
page: the two sides talk only through messages, each checking the other is
who framed it. It draws its outlines in a shadow root on an inert,
`aria-hidden` element, so your CSS cannot restyle them and screen readers never
meet them. It changes nothing on `<html>`, which React and Vue would report as
a hydration mismatch, and it survives client-side navigation, Astro's view
transitions included. Clicks belong to the page except while **Select** is on.

## Opening the page being edited

By default the frame opens the front of the site. Tell the studio where each
collection's entries live and it opens the page you are editing instead:

```yaml
# .cms/config.yaml
preview:
  paths:
    pages: { home: "/", "*": "/{slug}" }
    updates: "/updates/{slug}"
```

A plain path with `{slug}` covers most collections; a map lets one slug be the
front page. Regions, which are part of every page, preview at `/`.

## Getting rid of an unsaved edit

Leave the editor and come back and the draft is still in the form, with a
notice saying so: the preview and the form always show the same thing, and
publishing publishes what you see. "Discard unsaved edits" beside the frame
throws the draft away and puts your dev server back to what is published. It
is a plain form post, so it works with JavaScript switched off.

Anything still unsaved is listed on the site's page in the studio, and
`npx greatcms doctor` names it from the terminal: a draft you forgot is
otherwise visible only in dev, which is exactly where you would stop noticing
it.

For a dev server with none of the integrations above, **Reload the site**
beside the frame reloads it by hand.

## Pages built from a collection

Astro's dev server caches what `getStaticPaths()` returns. If it passes each
entry to the page as a prop, the preview keeps showing that cached copy and
never your edit. Return only the slug, and read the entry in the page itself:

```astro
---
export function getStaticPaths() {
  return cms.collection("pages").map((page) => ({ params: { slug: page.slug } }));
}

const page = cms.collection("pages").find((entry) => entry.slug === Astro.params.slug);
---
```

A build reads each entry once either way, so this costs nothing in production.

## The studio never builds your site

The studio cannot render a Hugo site, or a Laravel one, so it does not pretend
to. Building your site inside the studio would also break the rule that it never
executes anything from a repository it manages. Your dev server renders the
preview, on your machine, with your toolchain; your CI builds what you publish.
