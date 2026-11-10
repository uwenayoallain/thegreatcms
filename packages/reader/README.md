# @greatcms/reader

[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](https://github.com/uwenayoallain/thegreatcms#ai-assistance "Built with an AI coding assistant and reviewed by a human")

Reads GreatCMS content at build time: synchronous `node:fs` reads, schema
defaults for anything a file does not say, and nothing in the request path of
the site. A site built with it has no dependency on the studio.

```sh
npm install @greatcms/reader
```

```ts
import { createReader } from "@greatcms/reader";

const cms = createReader();
const hero = cms.region("home.hero"); // typed after `greatcms types`
const posts = cms.collection("posts"); // [{ slug, data, body }]
const sections = cms.blocks("home.sections"); // a blocks region, in order
```

`createReader()` is cheap to call wherever content is needed, a page, a layout,
a component: the schema and every content file are parsed once per process and
read again only when the file on disk has changed. Rich text comes back as the
HTML the file holds; the reader does not sanitize it, so a site that takes
content from people it would not let commit code should sanitize where it
renders. A content file over 32 MB, or a `.cms` file over 4 MB, is refused with
an error that names it. A content file that is a link to somewhere outside the
site root is not read.

In development the reader prefers an unsaved edit in `.cms/draft/` over the
committed file, which is what lets the studio preview a change in your own dev
server as you type. A production build never reads a draft.

One dev-only line per framework makes that preview work, and `greatcms init`
adds it for you:

| Framework        | One line                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Astro            | `astro.config`: `integrations: [greatcms()]` from `@greatcms/reader/astro`                                   |
| Next.js          | root layout: `<GreatcmsPreview />` inside `<head>`, from `@greatcms/reader/next`                             |
| Nuxt             | `nuxt.config`: `modules: ["@greatcms/reader/nuxt"]`                                                          |
| SvelteKit        | `vite.config`: `greatcmsWatch()` and `src/hooks.server`: `greatcmsHandle`, from `@greatcms/reader/sveltekit` |
| Other Vite sites | `vite.config`: `plugins: [greatcmsWatch()]` from `@greatcms/reader/vite`                                     |

In development it reloads the page when content changes (Next.js asks the
studio to reload it instead), hides the framework's dev toolbar while the page
is framed by the studio, and carries the inspector that lets the studio point
at what it is editing. The inspector draws in a shadow root on an inert,
`aria-hidden` element, so the page's own CSS, scripts and accessibility tree
never meet it, and it keeps working through client-side navigation such as
Astro's view transitions. A built page carries none of it.

Documentation: https://github.com/uwenayoallain/thegreatcms/blob/main/apps/docs/content/docs/getting-started.md · Source: https://github.com/uwenayoallain/thegreatcms
