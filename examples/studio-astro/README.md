# Paraline: a studio site with real motion

A fictional design and motion studio, built to show what a GreatCMS site can
look like when the design is ambitious. Every word, section and case study is
content in this folder; the look and the motion belong to the site.

```sh
pnpm dev                                               # from the repo root: studio + this site, connected
pnpm --filter @greatcms/example-studio-astro dev       # this site alone
pnpm --filter @greatcms/example-studio-astro test      # after a build
```

## Where things are

| Path                           | What it holds                                                        |
| ------------------------------ | -------------------------------------------------------------------- |
| `.cms/schema.yaml`             | The whole content model: blocks, four regions, the `work` collection |
| `content/cms/*.json`           | Studio identity, home hero, home sections, contact page              |
| `content/work/*.json`          | Case studies; covers are drawn from `palette` and `motif`            |
| `src/components/Section.astro` | One branch per home section type                                     |
| `src/components/Art.astro`     | The generated covers: four layers the stylesheet arranges            |
| `src/styles/site.css`          | Identity and layout, then every animation in one block at the end    |
| `src/scripts/motion.ts`        | Pointer effects, and stand-ins where scroll timelines are missing    |
| `deploy/`                      | The self-hosted stack: Caddy, studio, builder, on-demand preview     |

## How the motion is layered

1. **CSS does almost everything.** Loops (the hero's colour mesh, covers),
   entrances (the headline, word by word) and scroll-driven work: the
   reading-along statement, stacked services, the pinned sideways process,
   numbers that count with `@property`, and covers that morph into their case
   study through cross-document view transitions.
2. **The script adds what CSS cannot know**: where the pointer is. A labelled
   cursor, buttons that lean toward it, covers that tilt under it. In browsers
   without scroll timelines it also drives the scroll-driven parts.
3. **Reduced motion turns it all off.** Every animation sits inside
   `@media (prefers-reduced-motion: no-preference)`, and the script returns
   early. A test fails if an animation is ever started outside that block.

## Adding a home section

1. Add a block to `.cms/schema.yaml` and allow it in `home.sections`.
2. Run `pnpm --filter @greatcms/example-studio-astro types` for its TypeScript.
3. Add a branch for its `_type` in `src/components/Section.astro`.
4. Put its motion in the `prefers-reduced-motion: no-preference` block at the
   end of `site.css`, behind `@supports (animation-timeline: view())` if it
   is scroll-driven.
5. `pnpm build && pnpm test`, and `greatcms check` for the content.

## Budgets the tests hold

Every page under 30 KB of HTML, the stylesheet under 40 KB, one script under
24 KB, axe-clean, one `h1`, unique view-transition names per page, and no
internal link to a page that was not built.
