# @greatcms/spec

[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](https://github.com/uwenayoallain/thegreatcms#ai-assistance "Built with an AI coding assistant and reviewed by a human")

The GreatCMS content standard, as TypeScript. It parses `.cms/schema.yaml` and
`.cms/config.yaml`, parses and serialises content files, validates content
against a schema, and resolves a region to a document with schema defaults
filling anything missing. It holds no I/O, so a reader, a studio and a build
tool all resolve content by the same rules.

The standard itself is [SPEC.md](https://github.com/uwenayoallain/thegreatcms/blob/main/SPEC.md): JSON and
Markdown files in a repository, described by one schema file. This package is a
convenience for TypeScript; the format is readable from any language, and the
`@greatcms/conformance` fixtures say what reading it correctly means.

```sh
npm install @greatcms/spec
```

```ts
import { parseSchema, resolveRegion, validateRegion } from "@greatcms/spec";

const schema = parseSchema(readFileSync(".cms/schema.yaml", "utf8"));
const hero = resolveRegion(
  schema,
  "home.hero",
  JSON.parse(readFileSync("content/cms/home.hero.json", "utf8")),
);
const result = validateRegion(schema, "home.hero", hero);
```

A missing content file resolves to the schema's defaults; a missing schema is
an error. Fields may carry `when` conditions, blocks may declare `variants`,
and both resolve and validate here. The JSON Schemas for the two `.cms` files
ship in `json-schema/`.

## Validating a schema you did not write

A field's `pattern` is a regular expression from the schema, and validation
runs it over the content as it is. A pattern such as `^(a+)+$` can take longer
than anyone will wait on a long value, and the main entry, which runs anywhere,
does not guard against that itself. If the schema or the content comes from
somewhere you do not control (a pull request, a hosted editor), put a time
limit on patterns once, before you first validate. On Node:

```ts
import { usePatternMatcher } from "@greatcms/spec";
import { boundedMatch } from "@greatcms/spec/node";

usePatternMatcher(boundedMatch);
```

`greatcms check` and the studio both do this. A pattern V8 can run in linear
time is simply tested; one with a backreference, a lookaround or a large repeat
count is stopped after a tenth of a second and reported as `pattern_timeout`.

Documentation: https://github.com/uwenayoallain/thegreatcms/blob/main/apps/docs/content/docs/getting-started.md · Source: https://github.com/uwenayoallain/thegreatcms
