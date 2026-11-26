import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node26",
  outDir: "dist",
  clean: true,
  fixedExtension: false,
});
