import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node20",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
