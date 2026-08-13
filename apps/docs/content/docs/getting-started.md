---
title: Getting started
summary: Scaffold a site's configuration, connect it to the studio, publish.
order: 10
---

## Set up a repository

```sh
npx greatcms init
```

It detects what you build with — Astro, Next, Nuxt, SvelteKit, Eleventy, Hugo,
or Jekyll — and puts content where that generator already looks for it. Hugo
gets `data/cms`, Eleventy and Jekyll get `_data/cms`, Astro gets
`src/content/cms`. No wiring is needed afterwards in any of them.

You end up with two commented files: `.cms/schema.yaml` describing what may be
edited, and `.cms/config.yaml` describing where it goes.

## Read a region

A region resolves to a plain JSON file. In Astro:

```js
import hero from "../../src/content/cms/home.hero.json";
```

In Hugo, with no import at all:

```go
{{ $hero := index site.Data.cms "home.hero" }}
```

Or with schema defaults applied and types inferred:

```js
import { createReader } from "@greatcms/reader";
const cms = createReader();
const hero = cms.region("home.hero");
```

## Connect it

Run the studio, add the repository, and paste a token with `contents: write` on
it. The studio reads your schema and builds the editor from it. It never runs
any code from your repository.

## Check it

```sh
npx greatcms doctor
```

Prints every region, the file it resolves to, and which are still rendering
schema defaults.
