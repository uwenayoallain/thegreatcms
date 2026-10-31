# Hearth: a bakery on Next.js

A neighbourhood bakery's whole site, on Next.js 16 with the App Router. The
notice bar, hero, story, opening hours and menu are all content files in this
folder. Server Components read them through `@greatcms/reader`, and
`output: "export"` writes every page as HTML.

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

## Budgets the tests hold

axe-clean pages, one `h1` each, nothing of the studio in an exported page, one
minified stylesheet, the JavaScript Next.js brings kept under 700 KB before
compression, every menu item priced and grouped in the schema's order, and
every form control labelled.
