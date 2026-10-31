---
title: The hybrid model
summary: Why a region is opt-in, and what happens before anyone edits anything.
order: 20
---

Most of a page is code. A headline, a pricing table, and a rotating set of
feature cards are not: those change on a marketing schedule rather than a
release schedule, and they are the reason people install a CMS at all.

GreatCMS manages only what you list. Everything else is ordinary code the studio
never sees, never parses, and cannot break.

## Regions

A **region** is a named slice of a page: `home.hero`, `pricing.faq`. The id
doubles as the file name, so `home.hero` is stored at
`<regions dir>/home.hero.json`.

A **blocks region** holds an ordered list an editor can add to and reorder, from
a set of block types you allow. A **collection** is a folder of entries sharing
a shape, a blog, case studies, a changelog, stored as Markdown with
frontmatter, which is what every static site generator already expects.

## Defaults are not a fallback, they are the starting state

A missing content file is never an error. The region resolves to the `default`
values declared in the schema, so a site is correct **before the CMS has ever
run**, and stays correct if a field is added to the schema before anyone edits
it.

Stored content layers over those defaults: objects merge deeply, arrays are
replaced wholesale, and each block in a list is merged over its block type's
own defaults.

## What a site depends on

Its own files. There is no network call, no database, and no API key in a build.
The schema is part of the site and is committed alongside the code. What a site
never depends on is the studio: shut it down permanently and every site it
managed keeps building.
