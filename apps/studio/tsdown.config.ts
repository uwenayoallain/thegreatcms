import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/main.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    target: "node20",
    outExtensions: () => ({ js: ".js" }),
  },
  {
    // The visual editor: the studio's only client-side JavaScript, and a
    // progressive enhancement over a textarea that already works.
    entry: ["client/editor.ts", "client/preview.ts"],
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
