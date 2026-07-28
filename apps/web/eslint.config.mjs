import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
// Local plugin, imported by path: @wezesha/db exports only runtime entry points
// and a lint rule has no business in the package's public surface.
import tenantSafety from "../../packages/db/eslint-plugin-tenant-safety/index.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // A disable comment for a rule that no longer fires is an error, not a
    // warning. Keeps the tenant-safety exception list honest — and if the rule
    // below is ever unwired, every one of its disables turns into a failure
    // rather than silence.
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  // Un-scoped reads on the RLS-bypass service client fail the build. Everywhere
  // else the exception is per-call-site, via an inline disable that states why;
  // only the two surfaces below are exempt wholesale, and both are exempt
  // because spanning tenants is the module's entire purpose.
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "tenant-safety": tenantSafety },
    rules: { "tenant-safety/require-tenant-scope": "error" },
  },
  {
    // The admin console reads across every workspace by design (fleet health,
    // the audit ledger). Reached only through requireAdmin; never imported by a
    // tenant-facing page. A per-tenant client could not answer these questions.
    files: ["lib/admin/**/*.ts"],
    rules: { "tenant-safety/require-tenant-scope": "off" },
  },
  {
    // Tests assert on rows RLS is meant to hide — proving isolation requires
    // reading past it. Nothing here serves a request.
    files: ["tests/**/*.{ts,tsx}"],
    rules: { "tenant-safety/require-tenant-scope": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
