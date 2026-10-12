# Business Astro example

A fictional agribusiness site built from `greatcms init --template business`. It
shows the full content path rather than a static mockup:

- `.cms/schema.yaml` defines reusable feature, process, story, product and FAQ
  sections; company, owner/contact and search details; plus products and pages
  collections.
- `content/cms/*.json`, `content/products/*.json`, and `content/pages/*.json`
  are the editable source of truth.
- `src/components/SectionRenderer.astro` maps each section `_type` to site-owned
  presentation.
- `src/pages/[slug].astro` turns every managed page entry into a route; adding an
  entry can add its page, menu item, and footer link together.
- `src/pages/products/[slug].astro` gives every product a detail page without
  hand-writing another route.
- `@greatcms/reader` resolves defaults and gives pages generated schema types.

From the repository root:

```sh
pnpm --filter @greatcms/example-business-astro dev
```

Connect `examples/business-astro` as a local folder in the studio to edit it.
The built public site has no client JavaScript; the contact form is a plain POST.
