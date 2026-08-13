---
title: Accessibility
summary: What is enforced by the format, and what is enforced by tests.
order: 60
---

Accessibility here is structural where it can be, and a test where it cannot.

## Enforced by the format

`alt` is required on every image field by default. A field may declare
`alt: decorative-allowed`, which is the only way an empty alt validates — making
an inaccessible image a deliberate authoring act rather than an oversight.
Invalid content is refused before it reaches your repository.

Image width and height are read from the uploaded file's own header and stored
alongside it, so pages do not reflow while images load.

## Enforced by tests

The studio ships **zero JavaScript**. Every screen is server-rendered and every
mutation is a form POST — including adding, removing, and reordering blocks in a
block list. That is what makes the editor keyboard-operable and
screen-reader-legible by construction, rather than by patching ARIA onto
hand-built widgets.

axe runs against every studio screen and every page of the example site on each
CI run, with zero violations allowed. Errors are attached with `aria-invalid`
and `aria-describedby` rather than colour alone. The example site carries a
weight budget so "fast" cannot quietly stop being true.
