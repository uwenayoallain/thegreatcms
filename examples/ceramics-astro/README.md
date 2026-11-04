# Ibumba: a ceramics studio on Astro

[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](https://github.com/uwenayoallain/thegreatcms#ai-assistance "Built with an AI coding assistant and reviewed by a human")

A fictional pottery studio in Kigali that sells its work and teaches classes.
It started the way a new site does, with `npm create astro` and
`greatcms init`, and was then designed: every word is content in this folder,
and the clay, the type and the layout belong to the site.

```sh
pnpm dev                                                # from the repo root: studio + this site, connected
pnpm --filter @greatcms/example-ceramics-astro dev      # this site alone
pnpm --filter @greatcms/example-ceramics-astro build    # then `test`
```

## Where things are

| Path                            | What it holds                                                      |
| ------------------------------- | ------------------------------------------------------------------ |
| `.cms/schema.yaml`              | Blocks, five regions and the `workshops` collection                |
| `.cms/config.yaml`              | Content folders, and the page each workshop and region is seen on  |
| `src/content/cms/*.json`        | The regions. `booking` has no file and renders its defaults        |
| `src/content/workshops/*.md`    | One workshop per file: date and time, level, price, seats, details |
| `src/lib/cms.ts`                | The only place the site reads GreatCMS                             |
| `src/cms.d.ts`                  | Types generated from the schema (`pnpm types`)                     |
| `src/components/Sections.astro` | One branch per home section type                                   |
| `src/components/Vessels.astro`  | The drawn pots the hero shows until an editor uploads a photo      |

## What it shows

- **The path a real site takes.** `greatcms init` detected Astro, wrote the
  schema and config, added the reader and connected the live preview with one
  line in `astro.config.mjs`. Everything after that is ordinary Astro.
- **Times that mean one instant.** A workshop's date has `time: true`. The
  studio keeps the offset a value was saved with (`+02:00`), and the site
  formats it in `Africa/Kigali`, so a build on a server in another zone prints
  the same hour.
- **Regions with pages of their own.** `preview.paths` names `/visit/` and
  `/book/` for the regions shown there, so editing the opening hours frames
  the visiting page rather than the front page.
- **A form that needs no script.** Booking posts to the studio's inbox with a
  honeypot field and a `_redirect` back to a thank-you page. Full workshops
  drop out of its list.
- **No JavaScript on any page.** The tests check every built page for a
  script tag and for the studio's preview, and run axe against each one.
