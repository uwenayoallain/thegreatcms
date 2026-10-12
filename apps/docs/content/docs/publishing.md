---
title: Publishing
summary: One commit in your working copy, or nothing at all.
order: 30
---

A site is a folder on the machine the studio runs on. Publishing writes the
content files into that folder and commits them on whatever branch is checked
out. The commit is the deploy trigger: push it, and whatever CI the repository
already had does the rest. There is no webhook to configure and no cache to
purge.

A folder that is not a Git repository works too. The files are written, and
that is the whole job.

## One commit, or none

A publish touching a region and three uploaded images is **one commit**. Every
file is written to a temporary file first and then moved into place, so a full
disk or a bad path fails before any real file has changed. If Git refuses the
commit (a held `index.lock`, a missing `user.email`, a path in `.gitignore`), the
editor says so instead of reporting a publish that never happened.

Publishes to the same folder run one at a time, so a double-click or two open
tabs cannot interleave their writes.

The studio never runs your repository's Git hooks. They are code in the
repository, and the studio does not execute anything from a repository it
manages. Checks belong in CI, where they run on every commit anyway.

## Pushing for you

For an editor who should never see Git, turn on **Push after every publish**
in the site's settings. Each publish is then pushed to the branch's upstream,
and the host deploys it the way it deploys any push: edit, publish, live.

The push uses the Git credentials of the machine the studio runs on, never
prompts for a password, and never runs a pre-push hook. If it fails, the
commit is still there and the editor is told it is not live yet, with the
reason: most often the remote has commits this copy lacks, which
`git pull --rebase` in the site's folder sorts out. Publishes waiting to go
out are listed on the site's page, with a **Push now** button.

## Conflicts

A publish carries the commit the editor started from. If the content being
published changed since then, in a newer commit or as an uncommitted edit
someone made by hand, the publish is refused rather than overwriting it. Reload,
then publish again. A commit that touched other files is not a conflict, so
working on the site's code does not interrupt anyone editing its content.

Creating an entry never replaces one: if the title would produce a file name
that already exists, the studio asks for a different one.

## Validation happens first

Content is checked against the schema before anything is written, so invalid
content never reaches the repository. Alt text is part of that: the only way to
store an empty one is a field explicitly marked `alt: decorative-allowed`.

Run `greatcms check` in CI to hold hand-edited content to the same rules.
