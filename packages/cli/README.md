# @greatcms/cli

[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](https://github.com/uwenayoallain/thegreatcms#ai-assistance "Built with an AI coding assistant and reviewed by a human")

`greatcms`: local tools for a Git-backed site.

```sh
npx greatcms init            # .cms/schema.yaml and .cms/config.yaml for this project
npx greatcms setup           # scan an existing project and propose regions and sections
npx greatcms add region hero --field heading:text! --field body:richtext
npx greatcms add collection posts --field title:text! --field date:date
npx greatcms types --out src/cms.d.ts   # TypeScript from the schema
npx greatcms check [--json]  # validate every content file; non-zero for CI
npx greatcms doctor [--json] # what the setup looks like, and any unsaved draft
npx greatcms describe        # the content model in one screen
```

`init` detects Astro, Next, Nuxt, SvelteKit and Eleventy and writes a note for
coding agents into AGENTS.md. `add` edits the schema as text, keeping your
comments. `check` and `types --check` are the two commands CI should run.

`greatcms help <command>` (or `<command> --help`) shows a command's options and
examples, and `--version` prints the version. A typo gets a suggestion, and the
exit status is 0 when done, 1 on failure or problems found, 2 for bad usage and
130 when cancelled. For tab completion in bash, zsh or fish:

```sh
greatcms completion bash > ~/.local/share/bash-completion/completions/greatcms
greatcms completion zsh > "${fpath[1]}/_greatcms"
greatcms completion fish > ~/.config/fish/completions/greatcms.fish
```

Documentation: https://github.com/uwenayoallain/thegreatcms/blob/main/apps/docs/content/docs/the-command-line.md · Source: https://github.com/uwenayoallain/thegreatcms
