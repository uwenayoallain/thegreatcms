---
title: For coding agents
summary: Every surface an agent needs to wire a site up unattended, and the skill that teaches it.
order: 68
---

"Integrate from the standard in half an hour" should hold for a coding agent as
much as for a person. These are the surfaces, each reachable in one fetch, each
generated from the same sources as the pages people read, so they cannot
drift.

| Surface                              | Address                                    |
| ------------------------------------ | ------------------------------------------ |
| Index and integration summary        | `/llms.txt`                                |
| Every document in one file           | `/llms-full.txt`                           |
| Each page as Markdown                | `/spec.md`, `/docs/<page>.md`, `/index.md` |
| Manifest with entry points and steps | `/docs.json`                               |
| JSON Schema for `.cms/schema.yaml`   | `/json-schema/schema.schema.json`          |
| JSON Schema for `.cms/config.yaml`   | `/json-schema/config.schema.json`          |

## The skill

The repository ships an agent skill, `skills/greatcms/SKILL.md`: the commands,
the file shapes, the pitfalls and the checks, written to be followed without a
person in the loop. Install it into Claude Code, Cursor or any agent that
reads the open skills format:

```sh
npx skills add greatcms/greatcms@greatcms
```

## In the repository

`greatcms init` leaves a section in the site's `AGENTS.md` between
`<!-- greatcms:start -->` and `<!-- greatcms:end -->`, saying where content
lives, what to run before committing, and what not to touch. Running `init`
again updates that section and leaves the rest of the file alone.

Two commands produce machine-readable output for an agent to act on:

```sh
npx greatcms check --json     # every content file against the schema; exit code for CI
npx greatcms doctor --json    # regions, collections, what is still at defaults, unsaved drafts
npx greatcms describe         # every field you may write, its type and limits, and where its file goes
```

Errors from every command carry their remedy on a `fix:` line, in the exact
text that reaches stderr, so an agent can apply it rather than guess.

## What an agent should never do

Call the studio from a page, write into `.cms/draft/`, or ship JavaScript from
GreatCMS to a public site. The [invariants](/docs/the-hybrid-model/) are the
same for agents as for people.
