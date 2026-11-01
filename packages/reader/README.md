# @greatcms/reader

[![AI assisted](https://img.shields.io/badge/AI%20assisted-yes-8a63d2)](https://github.com/uwenayoallain/thegreatcms#ai-assistance "Built with an AI coding assistant and reviewed by a human")

Reads GreatCMS content at build time: synchronous `node:fs` reads, schema
defaults for anything a file does not say, and nothing in the request path of
the site. A site built with it has no dependency on the studio.

```sh
npm install @greatcms/reader
```

```ts
import { createReader } from "@greatcms/reader";

const cms = createReader();
const hero = cms.region("home.hero"); // typed after `greatcms types`
const posts = cms.collection("posts"); // [{ slug, data, body }]
const sections = cms.blocks("home.sections"); // a blocks region, in order
```

In development the reader prefers an unsaved edit in `.cms/draft/` over the
committed file, which is what lets the studio preview a change in your own dev
server as you type. A production build never reads a draft.

Two dev-only integrations make that preview work:

```js
// Vite
import { greatcmsWatch } from "@greatcms/reader/vite";
export default defineConfig({ vite: { plugins: [greatcmsWatch()] } });

// Astro
import greatcms from "@greatcms/reader/astro";
export default defineConfig({ integrations: [greatcms()] });
```

They reload the page when content changes, hide the framework's dev toolbar
while the page is framed by the studio, and carry the inspector that lets the
studio point at what it is editing. A built page carries none of it.

Documentation: https://github.com/uwenayoallain/thegreatcms/blob/main/apps/docs/content/docs/getting-started.md · Source: https://github.com/uwenayoallain/thegreatcms
