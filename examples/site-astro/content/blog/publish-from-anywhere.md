---
title: Publish from anywhere
description: What actually happens between pressing Publish and the page changing.
date: 2026-08-12
---

Pressing **Publish** writes your content into this repository as a single
commit. That commit is the deploy trigger: whatever CI this site already had
picks it up and rebuilds.

There is no webhook to configure, no cache to purge, and no database for the
site to query. The page you are reading was assembled at build time from a JSON
file and this Markdown file.

If the CMS were switched off tomorrow, this site would keep building.
