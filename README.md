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

Milestone 4 of 5. The standard is proven from two languages, the studio edits
and publishes real content to a real repository, and form submissions from any
site land in one inbox.

|                         |                                                                              |
| ----------------------- | ---------------------------------------------------------------------------- |
| ✅ **M0** Foundation    | pnpm + Turborepo, oxlint + oxfmt (Rust), tsdown/Rolldown, Vitest             |
| ✅ **M1** The standard  | `@greatcms/spec`, conformance kit, Node reader, Astro example, Python reader |
| ✅ **M2** Studio        | Auth, multi-site registry, schema-generated editor, atomic publishes         |
| ⬜ **M3** Preview       | Draft branch + your own CI, iframed                                          |
| ⬜ **M4** Dynamic layer | Forms, comments, inbox, email                                                |
| ⬜ **M5** Hardening     | Full a11y pass, perf budgets, CLI, docs                                      |

## What's here

```
apps/studio/            The CMS: sign in, connect repos, edit regions, publish
packages/spec/          The standard: schema parsing, validation, resolution rules
packages/git/           Atomic multi-file commits via the GitHub Git Data API
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

Run the studio:

```bash
pnpm --filter @greatcms/studio build
STUDIO_PASSWORD='something long' pnpm --filter @greatcms/studio start
# http://localhost:8787
```

Connect a repository containing a `.cms/schema.yaml` and a token with
`contents: write`, and it builds the editor from your schema. Point any site's
contact form at `https://your-studio/f/{siteId}/contact` and the messages arrive
in the inbox — set `RESEND_API_KEY`, `NOTIFY_FROM`, and `NOTIFY_TO` to be emailed
about them too. Or run it as a
container — `apps/studio/Dockerfile`, one process, one SQLite file, one volume.

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

**It is accessible.** axe runs against every page of the example site _and_
every screen of the studio, every form control is labelled, and errors are
attached with `aria-invalid` and `aria-describedby` rather than colour alone.

**The admin needs no JavaScript either.** The studio is server-rendered and
every mutation is a form POST — including adding, removing, and reordering
blocks. That is what makes it keyboard- and screen-reader-navigable by
construction rather than by patching ARIA onto custom widgets.

**A publish is one commit, or nothing.** Invalid content is refused before it
reaches the repository, and a branch that moved while you were editing gets a
409 rather than an overwrite.

**Form submissions need nothing on the site.** A plain HTML `<form>` posting to
the studio is the whole integration — no JavaScript, no third-party form
service, no per-site backend. Spam is scored with a honeypot, submission timing,
and a rate limit rather than a CAPTCHA, which is an accessibility tax paid by
every legitimate visitor to inconvenience a bot that solves them anyway.

**The awkward cases are covered.** The conformance fixture includes a region
with no content file, a region edited before a field was added to the schema, a
block missing a defaulted field, and a decorative image with empty alt text —
the four things naive implementations get wrong.

## Toolchain

Rust where a Rust tool exists, because build and check times are a feature:

| Job            | Tool                        | Why                                    |
| -------------- | --------------------------- | -------------------------------------- |
| Lint           | **oxlint** (oxc)            | Whole repo in ~1.4s, hundreds of rules |
| Format         | **oxfmt** (oxc)             | 65 files in ~0.7s, multi-threaded      |
| Library builds | **tsdown** (Rolldown + oxc) | ESM + declarations in ~2s per package  |
| Site builds    | **rolldown-vite**           | Astro build went 3.6s → 1.8s           |
| Task graph     | **Turborepo** (Rust)        | Content-hashed caching across packages |
| Tests          | **Vitest 4**                | Runs on the same Rolldown pipeline     |

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
a site is correct before the CMS has ever been opened. A missing _schema_ file
is an error — failing loudly beats quietly rendering empty regions.

**Publishing is one atomic commit.** Blob → tree → commit → ref via the GitHub
Git Data API, so a region and its images land together or not at all. Repeated
`PUT /contents` calls can half-apply, and half-applied content is how `main`
stops building.

## Licence

MIT.
