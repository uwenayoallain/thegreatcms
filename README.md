# thegreatcms

A Git-backed CMS for sites that shouldn't need one at runtime.

You pick which parts of a page it manages — a hero here, a feature list there,
an entire blog, or the whole site. Everything else stays hand-written code the
CMS never sees. Publishing writes files to your repository; the commit triggers
whatever deploy pipeline you already had. One studio manages many websites and
collects the things Git can't hold — form submissions, comments — into a single
inbox.

**It is not a framework plugin.** The integration surface is a schema file and
some JSON. Astro, Hugo, Eleventy, Next, Jekyll, Laravel, or a hand-rolled Go
generator all consume it the same way, in whatever language they're written in.

Read [SPEC.md](./SPEC.md) — that document is the actual product.

---

## Status

Milestone 1 of 5. The standard exists, is tested, and is proven from two
languages. The studio (the editing UI) is next.

| | |
|---|---|
| ✅ **M0** Foundation | pnpm + Turborepo, TypeScript strict, Biome, Vitest |
| ✅ **M1** The standard | `@greatcms/spec`, conformance kit, Node reader, Astro example, Python reader |
| ⬜ **M2** Studio | GitHub App auth, generated editor, atomic commits |
| ⬜ **M3** Preview | Draft branch + your own CI, iframed |
| ⬜ **M4** Dynamic layer | Forms, comments, inbox, email |
| ⬜ **M5** Hardening | Full a11y pass, perf budgets, CLI, docs |

## What's here

```
packages/spec/          The standard: schema parsing, validation, resolution rules
packages/conformance/   Fixtures + verifier that prove a tool reads it correctly
packages/reader/        Build-time reader for any JS framework
examples/site-astro/    A real Astro site: managed regions beside hand-written markup
examples/reader-python/ The same standard, implemented in ~120 lines of Python
```

## Try it

```bash
pnpm install
pnpm build
pnpm test
```

Then look at the example site:

```bash
pnpm --filter @greatcms/example-site-astro dev     # http://localhost:4321
```

The home page shows a managed hero next to a hand-written section — both end up
in the same static HTML. The about page renders from schema defaults, because
nobody has ever edited it.

## Proofs, not claims

Each of these is an automated test, not a bullet point in a pitch:

**It works in another language.** A Python reader written from `SPEC.md` alone
passes the same conformance suite:

```bash
python3 examples/reader-python/read.py packages/conformance/fixtures /tmp/out
node packages/conformance/bin/greatcms-conformance.mjs verify /tmp/out
# conformance: PASS (5 regions)
```

**It ships nothing to the browser.** The built example site contains zero
`<script>` tags and weighs 34 KB across four pages — asserted in
`examples/site-astro/tests/a11y.test.ts`.

**It is accessible.** axe runs against the built HTML for every page, every
form control is labelled, and the contact form submits with JavaScript disabled.

**The awkward cases are covered.** The conformance fixture includes a region
with no content file, a region edited before a field was added to the schema, a
block missing a defaulted field, and a decorative image with empty alt text —
the four things naive implementations get wrong.

## Design decisions worth knowing

**Content is JSON; prose is Markdown.** Every language parses JSON with no
dependencies, and every static site generator already has a Markdown pipeline.
Using one format for both would have fought one of those two facts.

**Rich text is sanitized HTML, with the editor AST beside it.** A consumer that
just wants to print a paragraph needs no library. `_ast` is there for anyone who
wants structural control, and is safe to ignore.

**Alt text is structurally required.** The only way to store an empty `alt` is a
field explicitly marked `alt: decorative-allowed`, which makes an inaccessible
image a deliberate act rather than an oversight.

**A missing content file is never an error.** It resolves to schema defaults, so
a site is correct before the CMS has ever been opened. A missing *schema* file
is an error — failing loudly beats quietly rendering empty regions.

**Publishing is one atomic commit.** Blob → tree → commit → ref via the GitHub
Git Data API, so a region and its images land together or not at all. Repeated
`PUT /contents` calls can half-apply, and half-applied content is how `main`
stops building.

## Licence

MIT.
