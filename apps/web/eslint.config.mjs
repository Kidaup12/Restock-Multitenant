import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
// Local plugin, imported by path: @wezesha/db exports only runtime entry points
// and a lint rule has no business in the package's public surface.
import tenantSafety from "../../packages/db/eslint-plugin-tenant-safety/index.mjs";
import costVisibility from "./eslint-rules/cost-visibility.mjs";

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
    // The money-blindness companion to the rule above. Tenant isolation has RLS
    // behind it; cost-blindness has only the author's memory, so an exported
    // getter that selects a cost column without a `canViewCosts` parameter is a
    // build failure. Applies everywhere a getter can live, not just lib/data —
    // moving a file must not quietly drop its cover.
    files: ["**/*.{ts,tsx}"],
    plugins: { "cost-visibility": costVisibility },
    rules: { "cost-visibility/require-cost-gate": "error" },
  },
  {
    // Four helpers that read cost columns and are not the surface the guarantee
    // is made at. Named one by one, never by directory: a new file next to any
    // of them is covered by the rule until it earns its own line here.
    //
    //   lib/metrics/catalogue.ts   The metrics contract. Returns moneyAtRestKes
    //     raw on purpose; its two consumers (lib/data/stock.ts,
    //     lib/data/insights.ts) both null it for a money-blind caller.
    //   lib/capabilities/setup-depth.ts   Reads costSource/costKes to answer
    //     "does this workspace have costs on file for the revenue that matters"
    //     — a workspace-level setup signal, naming no product and carrying no
    //     figure. It drives the onboarding nudge every role sees.
    //   lib/po/create-po.ts, lib/po/send-po.ts   Building and sending a
    //     purchase order IS the act of committing to costs; the supplier
    //     document is authorised by the send, not by who is looking. Both are
    //     reached only through a permission-checked server action.
    files: [
      "lib/metrics/catalogue.ts",
      "lib/capabilities/setup-depth.ts",
      "lib/po/create-po.ts",
      "lib/po/send-po.ts",
    ],
    rules: { "cost-visibility/require-cost-gate": "off" },
  },
  {
    // The admin console reads across every workspace by design (fleet health,
    // the audit ledger). Reached only through requireAdmin; never imported by a
    // tenant-facing page. A per-tenant client could not answer these questions.
    //
    // Named files, not the whole directory: `lib/admin/**` exempted code nobody
    // had read yet, including whatever landed there next — and something did
    // (the console-access grant/revoke). These five are the surfaces that span
    // tenants or work on tables with no tenantId at all (PlatformAdmin, User,
    // Account). A new file here is covered by the rule until it earns a line on
    // this list.
    files: [
      "lib/admin/fleet.ts",
      "lib/admin/audit.ts",
      "lib/admin/step-up.ts",
      "lib/admin/provision.ts",
      "lib/admin/admins.ts",
    ],
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
