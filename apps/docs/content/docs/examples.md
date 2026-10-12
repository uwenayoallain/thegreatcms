---
title: The examples
summary: Two Astro sites and a Python reader, each built to prove one thing.
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

## A complete small business

```sh
pnpm --filter @greatcms/example-business-astro dev
```

`examples/business-astro` is what `greatcms init --template business` grows
into: a fictional seed cooperative with company, contact, and search details;
a home page of reorderable sections (feature grids, an ordered process,
statistics, a story with an image, a product showcase, FAQs, a call to action);
a JSON collection of products, each with its own page; and a collection of
managed pages rendered through one dynamic route.

That last part is the point. Adding an About or a privacy policy is one new
collection entry: the page, its menu item, and its footer link appear together,
and the schema is untouched. The components are site-owned, so the CMS supplies
content shapes and never a look. Its tests build the site with real images in
place and check that width, height, and alt text all survive to the HTML.

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
