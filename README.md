# thegreatcms

[![CI](https://github.com/uwenayoallain/thegreatcms/actions/workflows/ci.yml/badge.svg)](https://github.com/uwenayoallain/thegreatcms/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@greatcms/cli?label=%40greatcms%2Fcli)](https://www.npmjs.com/package/@greatcms/cli)
[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](#ai-assistance "Built with an AI coding assistant and reviewed by a human")
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A Git-backed CMS for sites that shouldn't need one at runtime.

You pick which parts of a page it manages: a hero, a feature list, a whole blog,
or the entire site. Everything else stays hand-written code the CMS never sees.
Publishing writes files to your repository, and the commit triggers whatever
deploy pipeline you already had. One studio manages many sites and collects the
one thing Git can't hold, form submissions, in a single inbox.

It is not a framework plugin. The integration surface is a schema file and some
JSON, so a site reads it with an import and ships no runtime. `greatcms init`
scaffolds for Astro, Next.js, Nuxt, SvelteKit and Eleventy, and a Python reader
passes the same conformance suite as the TypeScript one.

The product is the file standard: read [SPEC.md](./SPEC.md).

## Quick start

In your site's repository:

```sh
npx greatcms init     # writes .cms/schema.yaml and .cms/config.yaml
npx greatcms check    # validates every content file; exits non-zero for CI
```

Read a region at build time. A region nobody has edited yet renders its schema
defaults:

```js
import { createReader } from "@greatcms/reader";

const hero = createReader().region("home.hero");
```

Run the studio from this repository (Node 22.18 or newer):

```sh
pnpm install && pnpm build
STUDIO_PASSWORD='something long' pnpm studio   # http://localhost:8787
```

Connect your site's folder, give it your dev server's URL, and the editor shows
your real components beside the form as you type.

## Documentation

| Guide                                                                      | What it covers                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Getting started](./apps/docs/content/docs/getting-started.md)             | Scaffold a site, read a region in each framework, connect, check |
| [The command line](./apps/docs/content/docs/the-command-line.md)           | `init`, `setup`, `add`, `types`, `check`, `doctor`, `describe`   |
| [The hybrid model](./apps/docs/content/docs/the-hybrid-model.md)           | Why regions are opt-in, and what renders before anyone edits     |
| [Publishing](./apps/docs/content/docs/publishing.md)                       | One commit in your working copy, or nothing                      |
| [Running the studio](./apps/docs/content/docs/running-the-studio.md)       | Environment variables, proxies, sessions, the container          |
| [Self-hosting](./apps/docs/content/docs/self-hosting.md)                   | Studio, builder and web server on one machine with Compose       |
| [Previewing](./apps/docs/content/docs/previewing.md)                       | Live editing inside your own dev server                          |
| [Forms and submissions](./apps/docs/content/docs/forms-and-submissions.md) | A plain HTML form, the inbox, email notifications                |
| [Accessibility](./apps/docs/content/docs/accessibility.md)                 | What the format enforces and what the tests enforce              |
| [Any language](./apps/docs/content/docs/any-language.md)                   | Reading the standard without TypeScript; the conformance suite   |
| [For coding agents](./apps/docs/content/docs/for-agents.md)                | `llms.txt`, JSON Schemas, the installable skill                  |
| [The examples](./apps/docs/content/docs/examples.md)                       | Five sites on four frameworks, and what each one proves          |
| [Design decisions](./DESIGN.md)                                            | Why it works the way it does, and the tests that hold it to that |
| [Contributing](./CONTRIBUTING.md)                                          | Developing this repository: commands, layout, toolchain          |

## Packages

| Package                                                                        | What it is                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [`@greatcms/cli`](https://www.npmjs.com/package/@greatcms/cli)                 | The `greatcms` command                                            |
| [`@greatcms/reader`](https://www.npmjs.com/package/@greatcms/reader)           | Build-time reader for any JavaScript framework, plus dev watchers |
| [`@greatcms/spec`](https://www.npmjs.com/package/@greatcms/spec)               | The standard in TypeScript: parsing, validation, resolution       |
| [`@greatcms/conformance`](https://www.npmjs.com/package/@greatcms/conformance) | Fixtures and a verifier for readers in any language               |
| [`@greatcms/deploy`](https://www.npmjs.com/package/@greatcms/deploy)           | Builds and serves a site on every publish, beside the studio      |

The studio itself lives in [`apps/studio`](./apps/studio) and runs from this
repository or its [Dockerfile](./apps/studio/Dockerfile).

## AI assistance

GreatCMS is built with an AI coding assistant, and every change is reviewed by
a human. Treat it as you would any new dependency: read what you run, and pin
versions.

## Licence

[MIT](./LICENSE).
