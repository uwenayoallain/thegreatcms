---
title: Previewing
summary: Your CI builds it, or your laptop does. Never our server.
order: 40
---

## In your own dev server

Point a local site at your dev server's URL and the editor shows your real
components beside the form. Publishing writes the files, your dev server
reloads, and the pane updates — usually within a couple of seconds.

For a Vite-based site this needs one plugin:

```js
import { greatcmsWatch } from "@greatcms/reader/vite";
export default defineConfig({ vite: { plugins: [greatcmsWatch()] } });
```

The reader reads content with the filesystem, which is what keeps it
framework-neutral, and it also means Vite has no idea those files are
dependencies. Without the watcher the file changes and the page does not.

## As you type

The editor shows a live preview of the content in the form — before any save,
commit, or branch. It updates as you type and needs nothing from your site.

What it renders is your _content_, in the structure your schema describes, using
the studio's own layout. It is deliberately not a mock-up of your design: an
approximation that looks like your site but is not would be worse than one that
plainly is not. It is the fastest way to check wording, block order, and whether
an image is missing its alt text.

Without JavaScript the pane becomes a button that renders the same preview in a
new tab.

For your real design, use one of the two below.

## Your CI builds it

The studio cannot render a Hugo site, or a Laravel one, so it does not pretend
to. Building your site on our server would also break the rule that the studio
never executes anything from a repository it manages.

**Save draft & preview** commits to `cms/draft-<region>`. Set
`preview.urlTemplate` in `.cms/config.yaml` and the studio iframes the resulting
URL:

```yaml
preview:
  urlTemplate: "https://{branch}--your-site.pages.dev"
```

Accurate, because it is your real build. Roughly thirty seconds, because it is
your real build.

## Or your laptop does

```sh
npx greatcms preview --branch cms/draft-home.hero --run "npm run dev"
```

This overlays the draft's content files onto your working copy, starts your dev
server, and restores the working copy exactly when you stop it — including
deleting files that did not exist before.

Two guards, because it writes into a working copy: it refuses to run on top of
uncommitted content changes, and refuses any draft branch carrying changes
outside your content directories. A draft carries content; a draft carrying
source changes is a mistake or an attack.
