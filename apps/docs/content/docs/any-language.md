---
title: Any language
summary: The standard is files. A reader in Python passes the same suite as the one in TypeScript.
order: 65
---

A site is managed by GreatCMS if it contains a schema file and reads content
from the paths the standard describes. That is the entire integration surface.
Hugo, Jekyll, Laravel, or a hand-rolled Go generator consume it exactly as
Astro does, because none of them need anything but YAML and JSON.

The JavaScript packages are a convenience, not a requirement.

## What a reader has to get right

Four cases, all of them in the conformance fixtures because naive
implementations get them wrong:

- **A region with no content file.** It resolves to the schema's `default`
  values. It is not an error.
- **Content written before a field was added.** The new field takes its default;
  the stored fields are kept.
- **A block missing a defaulted field.** Each block in a list is merged over its
  own block type's defaults.
- **A decorative image with empty alt text.** Valid only when the field is
  marked `alt: decorative-allowed`.

The rules are in [section 6 of the standard](/spec/#6-resolution-rules-the-important-part):
objects merge deeply, arrays are replaced wholesale, and a missing schema is a
loud error where a missing content file is not.

## Proving it

```sh
npx @greatcms/conformance fixtures        # prints the path to the fixture site
python3 read.py "$(npx @greatcms/conformance fixtures)" ./out
npx @greatcms/conformance verify ./out
# conformance: PASS
```

Point your reader at the fixture site, write every resolved region to
`<region-id>.json`, and, if it implements collections,
`entries/<collection>/<slug>.json`. The verifier compares each against the
expected document and reports collections separately, so a regions-only reader
still gets a useful answer.

## The reference in Python

`examples/reader-python/read.py` is a complete reader in about 120 lines of
Python, standard library plus PyYAML, written from the standard alone. CI runs
it against the fixtures on every build. It exists to keep the project honest:
if integrating in a new language needs more than one file's worth of code, the
standard has drifted towards whatever is convenient for JavaScript, and that is
a bug.

One detail it has to handle: the standard reads YAML 1.2, where `no` and `off`
are strings and a date is a string. PyYAML implements 1.1, so the reader
replaces the implicit type resolvers rather than patching the results.

## The machine-readable surface

The schemas for both `.cms` files are published as JSON Schema, which is what
gives editors autocomplete and lets a tool in any language validate a schema
before reading content:

- [/json-schema/schema.schema.json](/json-schema/schema.schema.json)
- [/json-schema/config.schema.json](/json-schema/config.schema.json)

For agents, [/llms.txt](/llms.txt) indexes every page, [/llms-full.txt](/llms-full.txt)
holds them in one fetch, and [/docs.json](/docs.json) lists the integration
steps. Every page here is also served as Markdown at its own path plus `.md`.
