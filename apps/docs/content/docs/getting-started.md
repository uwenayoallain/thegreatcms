---
title: Getting started
summary: Scaffold a site's configuration, connect it to the studio, publish.
order: 10
---

## Set up a repository

```sh
npx greatcms init
```

It detects what you build with — Astro, Next, Nuxt, SvelteKit, or Eleventy — and
puts content where that generator already looks for it. Eleventy gets
`_data/cms`, Astro gets `src/content/cms`, Next gets `content/cms`. No wiring is
needed afterwards in any of them.

You end up with two commented files: `.cms/schema.yaml` describing what may be
edited, and `.cms/config.yaml` describing where it goes.

## Read a region

A region resolves to a plain JSON file. In Astro:

```js
import hero from "../../src/content/cms/home.hero.json";
```

In Eleventy, with no import at all, because `_data` is global data:

```njk
<h1>{{ cms["home.hero"].heading }}</h1>
```

Or with schema defaults applied and types inferred:

```js
import { createReader } from "@greatcms/reader";
const cms = createReader();
const hero = cms.region("home.hero");
```

## Connect it

Run the studio and add the site. Point it at **a folder on this machine** and it
reads and writes that working copy directly — no token, no network. Give it your
dev server's URL and the editor shows your real components beside the form.

The studio reads your schema and builds the editor from it. It never runs any
code from your repository.

## Check it

```sh
npx greatcms doctor
```

Prints every region, the file it resolves to, and which are still rendering
schema defaults.
