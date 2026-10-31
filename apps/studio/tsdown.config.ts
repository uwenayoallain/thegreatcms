import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/main.ts"],
    format: ["esm"],
    dts: false,
    // One file, overwritten in place: cleaning first leaves `node --watch` a moment with nothing to run.
    clean: false,
    target: "node22",
    platform: "node",
    // One file with its dependencies inside, so the image needs no node_modules at all.
    deps: { alwaysBundle: [/.*/] },
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
    deps: { alwaysBundle: [/.*/] },
    target: "es2022",
    minify: true,
    outDir: "public",
    outExtensions: () => ({ js: ".js" }),
  },
]);
