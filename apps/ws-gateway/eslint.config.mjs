import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
// Local plugin, imported by path: @wezesha/db exports only runtime entry points
// and a lint rule has no business in the package's public surface.
import tenantSafety from "../../packages/db/eslint-plugin-tenant-safety/index.mjs";

// The gateway resolves a session and its memberships before any tenant context
// exists, so it holds the service client too. Known limit: it reaches the
// client through a lazy `import(...).then(db => db.prismaService)`, and the rule
// cannot follow that — the calls below it are invisible here. The rule is wired
// so that anything reaching for `prismaService` by name is covered, and so the
// gateway stops being the one service with no tripwire at all.
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
