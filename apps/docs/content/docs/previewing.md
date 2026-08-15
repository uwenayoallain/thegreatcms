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
publishes — the frame simply shows the site as last published.

## Getting rid of an unsaved edit

"Discard unsaved edits" beside the frame throws the draft away and puts your dev
server back to what is published. It is a plain form post, so it works with
JavaScript switched off.

Anything still unsaved is listed on the site's page in the studio, and
`npx greatcms doctor` names it from the terminal — a draft you forgot is
otherwise visible only in dev, which is exactly where you would stop noticing
it.

If your dev server is not Vite-based, the watcher plugin cannot reload it for
you; **Reload the site** beside the frame does it by hand.

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
