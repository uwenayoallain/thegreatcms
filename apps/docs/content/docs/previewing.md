---
title: Previewing
summary: Your CI builds it, or your laptop does. Never our server.
order: 40
---

The studio cannot render a Hugo site, or a Laravel one, so it does not pretend
to. Building your site on our server would also break the rule that the studio
never executes anything from a repository it manages.

## Your CI builds it

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
