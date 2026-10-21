import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "out/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "contract/target/**",
      "public/ocr/**",
    ],
  },
  ...compat.extends("next/core-web-vitals"),

  // Playwright fixtures destructure an empty pattern (`async ({}, use) => …`)
  // and call a function named `use`. That is Playwright's fixture API, not the
  // React `use` hook, but react-hooks/rules-of-hooks matches on the name alone.
  // The empty pattern is likewise required by Playwright, not an oversight.
  {
    files: ["e2e/**/*.ts", "e2e/**/*.tsx", "playwright.config.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "no-empty-pattern": "off",
    },
  },
];

export default eslintConfig;
