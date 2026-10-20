import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "**/lib/**", "uploadzip/**"] },
  js.configs.recommended,
  {
    files: ["extension/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.serviceworker, chrome: "readonly" },
    },
    rules: {
      "no-unused-vars": "off",
      "no-empty": "off",
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { ...globals.node } },
  },
];
