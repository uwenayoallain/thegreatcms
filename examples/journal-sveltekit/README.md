# The Long Light: a writer's journal on SvelteKit

[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](https://github.com/uwenayoallain/thegreatcms#ai-assistance "Built with an AI coding assistant and reviewed by a human")

Essays as Markdown files with frontmatter, the format every static site
generator already reads, published by SvelteKit as plain HTML. The studio edits
them like any collection; the reader turns them into pages at prerender time.

```sh
pnpm dev                                                # from the repo root: studio + every example
pnpm --filter @greatcms/example-journal-sveltekit dev   # this site alone, on Vite's dev server
pnpm --filter @greatcms/example-journal-sveltekit build # then `test`
```

## Where things are

| Path                  | What it holds                                                  |
| --------------------- | -------------------------------------------------------------- |
| `.cms/schema.yaml`    | Identity, home introduction, about page, newsletter, `essays`  |
| `content/essays/*.md` | One essay per file: title, dek, date, tags, then the Markdown  |
| `content/cms/*.json`  | The regions. `newsletter` has no file and renders its defaults |
| `src/lib/cms.js`      | The only place the site reads GreatCMS                         |
| `src/hooks.server.js` | Adds the studio's preview chrome while developing              |
| `src/routes/`         | Home, essay, about, and a prerendered `404.html`               |
| `vite.config.js`      | SvelteKit's config, the reader's Vite plugin, CSS targets      |

## How SvelteKit meets GreatCMS

- **Prerendered, with no client runtime.** `csr = false` in the root layout
  means no hydration, so a built page has no `<script>` and no module preloads.
  `trailingSlash = "always"` writes each page as a folder, so links work on any
  static host, and the 404 page is a real route rather than the SPA fallback,
  which would bring the runtime back.
- **The Vite plugin for reloads.** `greatcmsWatch()` reloads the page when
  content changes, the studio's unsaved drafts included.
- **A hook for the preview.** SvelteKit renders pages itself rather than
  through Vite's `index.html`, so `transformPageChunk` in `hooks.server.js`
  adds the preview chrome, in development only.
- **A newsletter without a service.** The form posts to the studio's inbox.

## Budgets the tests hold

axe-clean pages, one `h1` each, no script or module preload in any built page,
every essay listed newest first and rendered from its Markdown, and a labelled
form that posts to the studio.
