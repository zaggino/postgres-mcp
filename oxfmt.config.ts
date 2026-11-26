import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "dist",
    ".claude",
    "**/*.md",
    ".github",
    "examples",
    "assets",
  ],
});
