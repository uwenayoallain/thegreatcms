import greatcms from "@greatcms/reader/astro";
import { defineConfig } from "astro/config";

// The public name the tunnelled preview reaches this dev server by; Vite refuses other hosts.
const previewHost = process.env.PREVIEW_HOST;

export default defineConfig({
  site: "https://ibumba.example",
  build: { format: "directory" },
  integrations: [greatcms({ root: new URL(".", import.meta.url).pathname })],
  vite: { server: { allowedHosts: previewHost ? [previewHost] : undefined } },
});
