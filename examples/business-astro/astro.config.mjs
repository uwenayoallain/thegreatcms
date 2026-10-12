import greatcms from "@greatcms/reader/astro";
import { defineConfig } from "astro/config";

// Behind the self-hosted preview proxy the dev server answers to a public name; Vite only serves hosts it knows.
const previewHost = process.env.PREVIEW_HOST;

export default defineConfig({
  site: "https://kivu-seedworks.example",
  build: { format: "directory" },
  integrations: [greatcms({ root: new URL(".", import.meta.url).pathname })],
  vite: { server: { allowedHosts: previewHost ? [previewHost] : undefined } },
});
