// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        ...globals.browser,
        // Obsidian globals
        createDiv: "readonly",
        createSpan: "readonly",
        createFragment: "readonly",
        createSvg: "readonly",
      },
    },
    rules: {},
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  globalIgnores(["node_modules/*", "main.js"]),
]);
