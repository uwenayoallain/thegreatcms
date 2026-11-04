import greatcms from "@greatcms/reader/astro";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://ibumba.example",
  build: { format: "directory" },
  integrations: [greatcms({ root: new URL(".", import.meta.url).pathname })],
});
