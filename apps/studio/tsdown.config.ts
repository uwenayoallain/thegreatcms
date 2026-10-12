import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/main.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    target: "node22",
    outExtensions: () => ({ js: ".js" }),
  },
  {
    // The studio's only client-side JavaScript, and an enhancement over a real textarea.
    entry: ["client/editor.ts", "client/live.ts", "client/form.ts", "client/shell.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    platform: "browser",
    // Bundle the editor and its dependencies: the browser has no node_modules.
    noExternal: [/.*/],
    target: "es2022",
    minify: true,
    outDir: "public",
    outExtensions: () => ({ js: ".js" }),
  },
]);
