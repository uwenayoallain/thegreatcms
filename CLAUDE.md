# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read [AGENTS.md](./AGENTS.md) first — it holds the invariants (design decisions
that must not be "fixed") and the current focus. This file covers commands and
the architecture that spans several files.

## Commands

```sh
pnpm install
pnpm check        # the gate: oxlint, oxfmt --check, docs:check, typecheck, test
pnpm build        # turbo run build (tsdown per package; Astro for the sites)
pnpm test         # turbo run test (build runs first — tests import dist/)
pnpm docs:build   # regenerate docs/ from SPEC.md + README.md
```

Per-package work (turbo filters, package names are `@greatcms/<dir>`):

```sh
pnpm --filter @greatcms/spec test
pnpm --filter @greatcms/studio exec vitest run tests/media.test.ts   # one file
pnpm --filter @greatcms/studio exec vitest run -t "rejects svg"      # one test
```

`test` depends on `build`, so after changing a package that another one imports,
run `pnpm build` before the dependent's tests — invoking `vitest` directly skips
that. Vitest watch mode is not wired into turbo — run
`pnpm --filter <pkg> exec vitest` directly.

Running things:

```sh
STUDIO_PASSWORD='something long' pnpm --filter @greatcms/studio dev   # :8787
pnpm --filter @greatcms/docs dev
pnpm --filter @greatcms/example-site-astro dev                        # :4321
```

Browser tests (ProseMirror, live preview, colour contrast) need Chromium once:

```sh
pnpm --filter @greatcms/studio exec playwright install chromium
```

Without it they skip rather than fail — a green run on a fresh checkout has not
proven the client side.

Cross-language conformance (CI runs this every build):

```sh
python3 examples/reader-python/read.py packages/conformance/fixtures /tmp/out
node packages/conformance/bin/greatcms-conformance.mjs verify /tmp/out
```

## Architecture

The product is the **file standard** in `SPEC.md`: `.cms/schema.yaml`,
`.cms/config.yaml`, and JSON/Markdown content files in the repository. Every
package is an implementation of that document; if they disagree, the code is
wrong.

**`packages/spec`** is the single source of truth for the format in TypeScript —
schema parsing (`schema.ts`), config (`config.ts`), field types and defaults
(`fields.ts`), content parsing/serializing (`content.ts`), validation
(`validate.ts`), and path resolution (`paths.ts`). It is a convenience, not a
requirement: it holds no I/O, so both the reader and the studio depend on it for
the same resolution rules. Field types and their storage shapes live in
`fields.ts` — adding a field type means touching that, `validate.ts`, the
studio's `views/fields.ts` renderer, and `SPEC.md`.

**Resolution** is the concept that ties the halves together: a schema region plus
an optional content file resolves to a document, with schema defaults filling
anything missing (`resolveRegion`). A missing content file is normal; a missing
schema is fatal.

**`packages/reader`** is the build-time consumer — synchronous `node:fs` reads,
no framework code. `vite.ts` exports `greatcmsWatch()`, needed because
filesystem reads are invisible to Vite's dependency graph.

**`apps/studio`** is a Hono server, server-rendered, every mutation a form POST.
The layering:

- `main.ts` wires env → `Store` (SQLite via `node:sqlite`) → `createApp`.
- `app.ts` is the whole HTTP surface: auth, site CRUD, the editor, publish,
  media upload, form intake, inbox.
- `repo.ts` defines `Repository` — the seven operations the studio needs from a
  site's files — with `GitHubRepository` and `LocalRepository` implementations.
  **Adding a backend means implementing that interface, not branching in
  `app.ts`.** Everything above this line is backend-agnostic.
- `sites.ts` (`SiteClient`) sits on `Repository` and speaks in schema/config/
  regions/collections rather than files.
- `views/` renders HTML: `pages.ts` (screens), `fields.ts` (one renderer per
  field type, plus error attachment), `preview.ts` (the studio-layout live
  preview), `layout.ts`.
- `client/*.ts` is the only browser JavaScript (ProseMirror editor + live
  preview). tsdown builds it to `public/*.js` in the same `pnpm build`; those
  files are build output, and are loaded only on screens with a richtext field.

**`packages/git`** implements the atomic publish: blob → tree → commit → ref via
the GitHub Git Data API, plus PRs and `ConflictError` when a branch moved. Never
use the contents API here — it is one commit per file.

**`packages/cli`** is `greatcms init` (framework detection in `detect.ts`,
scaffolding in `init.ts`), `preview` (overlays a draft branch onto the working
copy, restores it exactly on exit), and `doctor`.

**`packages/conformance`** is fixtures plus a verifier; it defines what "reads
the standard correctly" means for any implementation in any language. The
fixtures deliberately include the awkward cases — missing content file, content
predating a schema field, block missing a defaulted field, decorative empty alt.

**`docs/`** is generated by `scripts/gen-agent-docs.mjs` from `SPEC.md` and
`README.md`. Never edit it by hand; CI fails on drift.

## Conventions

- Comments are deliberately sparse: a one-line file docstring, and a single line
  where the code cannot say it itself. Do not reintroduce block essays. Prefer a
  regression test over a comment about a bug.
- Tooling is Rust-first (oxlint, oxfmt, tsdown, rolldown-vite). Do not
  reintroduce ESLint, Prettier, or plain Rollup. `pnpm lint:fix` and
  `pnpm format` fix mechanically.
- ESM only, `.js` extensions in relative imports, Node >= 20.11, pnpm.
- Changing the standard means bumping `version:` in the spec and documenting a
  migration; new optional keys and field types are additive within version 1.
