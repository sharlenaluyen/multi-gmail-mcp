import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";

export default [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      // Catches an unused import or a typo'd variable - the kind of thing
      // that's easy to miss by eye in a server with 15+ similar tool
      // handlers.
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off", // auth.js is a CLI script; console output is the UI
    },
  },
  prettierConfig, // turn off stylistic rules that would fight with prettier
];
