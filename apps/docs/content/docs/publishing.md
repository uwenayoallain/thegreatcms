---
title: Publishing
summary: Direct commits, pull requests, and why a publish is atomic.
order: 30
---

Each site publishes one of two ways, chosen when you connect it.

## Direct

A publish commits to your branch. The commit is the deploy trigger — whatever CI
the repository already had does the rest. There is no webhook to configure and
no cache to purge.

## As a pull request

A publish commits to a draft branch and opens a pull request against yours, so a
content change gets the review, CI preview build, and revert-to-roll-back that a
code change already gets. Saving again updates the open pull request rather than
opening a second one.

Titles are generated from the field-level diff:

> Update heading in Home hero on Example

with a table of every changed field in the body. A site may opt in to a model
writing the title instead, through any OpenAI-compatible endpoint. Publishing
never waits on it: the call is time-boxed and every failure falls back to the
generated title, and the body stays machine-generated because a reviewer needs
the change list to be true rather than fluent.

## One commit, or none

Writes go through the Git Data API — blob, tree, commit, update ref — so a
publish touching a region and three uploaded images is **one commit**. Repeated
`PUT /contents` calls are one commit per file and can half-apply, and
half-applied content is how a main branch stops building.

A publish also carries the commit it started from. If the branch moved while the
editor was open, the publish is refused with a message rather than overwriting
the other change.

## Validation happens first

Content is checked against the schema before anything is written, so invalid
content never reaches the repository. Alt text is part of that: the only way to
store an empty one is a field explicitly marked `alt: decorative-allowed`.
