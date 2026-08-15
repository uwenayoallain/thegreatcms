import { defineConfig } from "tsdown";

// Rolldown + oxc: builds in milliseconds, emits ESM and declarations.
export default defineConfig({
  entry: ["src/index.ts", "src/vite.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  treeshake: true,
  // Plain .js/.d.ts so package.json exports stay obvious and every consumer resolves them without thinking.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
