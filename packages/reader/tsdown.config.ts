import { defineConfig } from "tsdown";

// Rolldown + oxc: builds in milliseconds, emits ESM and declarations.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/vite.ts",
    "src/astro.ts",
    "src/next.ts",
    "src/nuxt.ts",
    "src/nuxt-nitro.ts",
    "src/sveltekit.ts",
  ],
  format: ["esm"],
  dts: true,
  // Written over in place, never emptied first: running dev servers import these files.
  clean: false,
  target: "node20",
  treeshake: true,
  // Plain .js/.d.ts so package.json exports stay obvious and every consumer resolves them without thinking.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
