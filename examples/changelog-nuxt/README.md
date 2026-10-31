# Sundial: a product changelog on Nuxt

A product site and changelog on Nuxt 4. The identity, hero, features, pricing,
FAQ and releases are all content files in this folder. A Nitro server route
reads them through `@greatcms/reader`, and `nuxt generate` writes every page as
HTML with `noScripts: true`.

```sh
pnpm dev                                              # from the repo root: studio + every example
pnpm --filter @greatcms/example-changelog-nuxt dev    # this site alone, on nuxt dev
pnpm --filter @greatcms/example-changelog-nuxt build  # then `test`
```

## Where things are

| Path                                 | What it holds                                                   |
| ------------------------------------ | --------------------------------------------------------------- |
| `.cms/schema.yaml`                   | Five regions and the `changelog` collection                     |
| `content/cms/*.json`                 | Identity, hero, features, pricing, FAQ                          |
| `content/changelog/*.md`             | One release per file: version, title, date, kind, then Markdown |
| `server/api/cms.get.ts`              | The server route where the reader resolves content              |
| `server/plugins/greatcms-preview.ts` | Adds the studio's preview chrome while developing               |
| `app/composables/cms.ts`             | Shared types and `useCms()`                                     |
| `app/pages/`, `app/layouts/`         | Home, changelog, release, thanks, and a prerendered `404.html`  |
| `nuxt.config.ts`                     | Nuxt's config, the reader's Vite plugin, and `noScripts: true`  |

## How Nuxt meets GreatCMS

- **Prerendered, with no client runtime.** `$production` sets `noScripts: true`
  on every route, so `nuxt generate` emits complete HTML with no bundle or
  module preload. Development keeps its client, which reloads the page when
  content changes.
- **Read in Nitro.** `server/api/cms.get.ts` creates a reader (`drafts: import.meta.dev`)
  and resolves every region and release; `nuxt generate` captures the response
  into static HTML.
- **The Vite plugin and Nitro hook for preview.** `greatcmsWatch()` reloads
  `nuxt dev` on content edits (drafts included), and `server/plugins/greatcms-preview.ts`
  injects the preview chrome in development only.
- **A waitlist without a service.** The beta form posts to the studio's inbox.

## Budgets the tests hold

axe-clean pages, one `h1` each, no executable script or module preload in any
generated page, every release listed newest first and rendered from its
Markdown, and a labelled form that posts to the studio.
