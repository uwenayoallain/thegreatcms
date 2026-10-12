> Built with an AI coding assistant and reviewed by a human. Treat it as you would any new dependency.

# @greatcms/conformance

What "reads the GreatCMS standard correctly" means, as a fixture site and the
documents any reader must resolve it to. The fixture deliberately holds the
awkward cases: a region with no content file, content written before a field
was added, a block missing a defaulted field, a block that names no variant,
a decorative empty alt, and a Markdown collection.

```sh
npx greatcms-conformance fixtures          # path to the fixture site
npx greatcms-conformance verify ./out      # compare a reader's output
npx greatcms-conformance verify --self     # verify the reference reader
```

A reader writes one JSON file per region to a folder, plus
`entries/<collection>/<slug>.json` if it implements collections, and
`verify` compares them with `expected/`. The repository's Python reader
passes it, which is how the format stays language-agnostic.

Documentation: https://greatcms.dev/docs/any-language/ · Source: https://github.com/uwenayoallain/thegreatcms
