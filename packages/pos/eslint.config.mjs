import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
// Local plugin, imported by path: @wezesha/db exports only runtime entry points
// and a lint rule has no business in the package's public surface.
import tenantSafety from "../db/eslint-plugin-tenant-safety/index.mjs";

// The POS feed has no session, so like the worker every query here runs on the
// RLS-bypass service client — and unlike the worker it is reached by an
// unauthenticated request carrying a slug and a secret, which makes it the one
// place where a missing tenantId is remotely triggerable. The tripwire ran over
// nothing here until now.
const eslintConfig = defineConfig([
  {
    // A disable comment for a rule that no longer fires is an error, not a
    // warning — it keeps the exception list honest, and if the rule below is
    // ever unwired every disable fails rather than going quiet.
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: "module" },
    plugins: { "tenant-safety": tenantSafety },
    rules: { "tenant-safety/require-tenant-scope": "error" },
  },
  {
    // Tests assert on rows RLS is meant to hide — proving isolation requires
    // reading past it. Nothing here serves a request.
    files: ["tests/**/*.ts"],
    rules: { "tenant-safety/require-tenant-scope": "off" },
  },
  globalIgnores(["dist/**"]),
]);

export default eslintConfig;
