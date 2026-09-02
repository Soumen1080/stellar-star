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
    ],
  },
  ...compat.extends("next/core-web-vitals"),

  // Playwright fixtures take a callback conventionally named `use`. It is not a
  // React hook, but `react-hooks/rules-of-hooks` matches on the name alone and
  // reports every fixture as an illegal hook call.
  {
    files: ["e2e/**/*.ts", "e2e/**/*.tsx"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },

  // `jest/*` rules come from eslint-plugin-jest, which this project does not
  // install; the inline disable comment for one therefore errors out as an
  // unknown rule. Test files get the core rules only.
  {
    files: ["__tests__/**/*.ts", "__tests__/**/*.tsx"],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },

  // global-error.tsx renders when the root layout itself has failed, replacing
  // the whole document. `next/link` relies on the router that is unavailable at
  // that point, so a plain anchor doing a full reload is the correct escape.
  {
    files: ["app/global-error.tsx"],
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
];

export default eslintConfig;
