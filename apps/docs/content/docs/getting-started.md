---
title: Getting started
summary: Scaffold a site's configuration, connect it to the studio, publish.
order: 10
---

## Set up a repository

```sh
npx greatcms init
```

It detects what you build with (Astro, Next.js, Nuxt or SvelteKit) and puts
content where that framework already looks for it: Astro and SvelteKit get
`src/content/cms`, the others `content/cms`.

You end up with two commented files: `.cms/schema.yaml` describing what may be
edited, and `.cms/config.yaml` describing where it goes. After asking, `init`
also adds `@greatcms/reader` to `package.json` and the one line that connects
the studio's live preview to your framework's config (the
[table on Previewing](/docs/previewing/) lists them). Each is a single additive
edit; a config it does not recognise is left alone and the line is printed for
you instead. `--no-wire` skips both. Then install with your package manager.

For a product or service business, start with the recurring pieces already
wired together:

```sh
npx greatcms init --template business
```

That gives editors company, owner/contact and search details, a hero,
reorderable page sections for features, ordered processes, statistics, stories,
products, FAQs and calls to action, and JSON collections for products and pages.
The CMS supplies the content shape; your own components still decide how every
section looks.

Render the pages collection through one dynamic route in your framework. An
editor can then add an About, Services, or legal page as a normal collection
entry; `showInNavigation` and `navigationOrder` make the menu update from the
same data. `greatcms init --template business` writes this collection for you.

## Add another kind of section

Define it and make it selectable in the page editor with one command:

```sh
npx greatcms add section testimonial --to home.sections \
  --field quote:richtext! --field name:text!
```

If the schema has only one reorderable region, `--to` is optional. Implement
the new `_type: "testimonial"` case once in your site's section renderer; from
then on editors can add, remove and reorder testimonials without touching YAML
or adding another route.

## Read a region

A region resolves to plain data. Read it through the schema-aware reader, so a
brand-new region renders its defaults before its JSON file exists. It is the
same call in every framework; only where it runs differs. In Astro, in a page's
frontmatter:

```js
import { createReader } from "@greatcms/reader";
const cms = createReader();
const hero = cms.region("home.hero");
```

In Next.js, in a Server Component, so the file is read on the server and never
fetched by the browser:

```tsx
import { createReader } from "@greatcms/reader";

export default function Home() {
  const hero = createReader().region("home.hero");
  return <h1>{hero.heading}</h1>;
}
```

In SvelteKit the same call goes in a `+page.server.js` load function, and in
Nuxt in a server route the page fetches. [The examples](/docs/examples/) run
all four.

The same reader infers types when you run `greatcms types`.

## Connect it

Run the studio and add the site. Point it at **a folder on this machine** and it
reads and writes that working copy directly: no token, no network. Give it your
dev server's URL and the editor shows your real components beside the form.

The studio reads your schema and builds the editor from it. It never runs any
code from your repository.

## Check it

```sh
npx greatcms doctor
```

Prints every region, the file it resolves to, and which are still rendering
schema defaults.

To check the content itself: in a build, or before you push:

```sh
npx greatcms check
```

It validates every content file and collection entry against your schema, and
exits non-zero if anything would not render: a required field left empty, a
field the schema no longer has, a file no region renders, an image pointing at
something nobody committed. `--json` reports the same to a machine.

A region with no content file is not a failure: it renders schema defaults,
which is the point.
