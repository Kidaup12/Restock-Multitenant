import { describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * Mechanical RLS coverage census against the live schema: a tenant table that
 * ships without its policy fails CI here, no human vigilance required.
 */

// Tables that are ALLOWED to have no tenantId column. Additions are a reviewed
// decision, not a default.
const GLOBAL_TABLES = [
  // Tenant carries no tenantId column because its own id IS the tenant id, so
  // the census below cannot see it. It is covered by its own test instead —
  // being unable to spot a table is not the same as that table being exempt.
  "Tenant",
  "_prisma_migrations",
  // Better Auth tables — users span tenants (Membership is the per-tenant link).
  // User is readable by the tenant client under its own tenant_visible_users
  // policy; the other three are unreachable by that role entirely, which the
  // credential-table test below enforces.
  "User",
  "Session",
  "Account",
  "Verification",
  // Shopify webhook dedupe ledger — keyed by the delivery id
  // (X-Shopify-Webhook-Id), which is checked before the tenant is resolved, so
  // there is no tenantId to scope on. Rows do name the merchant via shopDomain;
  // only the service client reads this table.
  "WebhookEvent",
  // Who may reach the operator console. Platform-wide by definition, so there is
  // no tenantId to scope on — it is instead locked away from the request-time
  // role entirely, which the locked-table test below enforces.
  "PlatformAdmin",
];

/** Tables the request-time role must not be able to reach at all: session
 *  tokens, password hashes and OAuth tokens, plus the list of who can read every
 *  workspace. See the lock_credential_tables and platform_admin migrations. */
const LOCKED_TABLES = ["Session", "Account", "Verification", "PlatformAdmin"];

describe("rls coverage census", () => {
  it("every tenantId table has RLS enabled and a two-sided tenant_isolation policy", async () => {
    const client = new Client({ connectionString: process.env.DIRECT_URL });
    await client.connect();
    try {
      const { rows: tables } = await client.query<{ table_name: string; has_tenant_id: boolean }>(
        `SELECT t.tablename AS table_name,
                EXISTS (SELECT 1 FROM information_schema.columns c
                         WHERE c.table_schema = 'public'
                           AND c.table_name = t.tablename
                           AND c.column_name = 'tenantId') AS has_tenant_id
           FROM pg_tables t WHERE t.schemaname = 'public'`
      );

      const tenantTables = tables.filter((t) => t.has_tenant_id).map((t) => t.table_name);
      const globals = tables.filter((t) => !t.has_tenant_id).map((t) => t.table_name);

      const unexpectedGlobals = globals.filter((t) => !GLOBAL_TABLES.includes(t));
      expect(unexpectedGlobals, "tables without tenantId must be allow-listed in GLOBAL_TABLES").toEqual([]);

      for (const table of tenantTables) {
        const { rows: sec } = await client.query(
          `SELECT t.rowsecurity, c.relforcerowsecurity AS forced
             FROM pg_tables t
             JOIN pg_class c ON c.relname = t.tablename
              AND c.relnamespace = 'public'::regnamespace
            WHERE t.schemaname = 'public' AND t.tablename = $1`,
          [table]
        );
        expect(sec[0]?.rowsecurity, `${table}: ROW LEVEL SECURITY must be enabled`).toBe(true);
        // ENABLE exempts the table's owner from its own policies. That is only
        // survivable while the app role owns nothing — and a restore is exactly
        // where that stops being true, since whoever runs pg_restore owns what
        // it recreates. FORCE removes the exemption; BYPASSRLS (postgres,
        // wezesha_service) still outranks it, so migrations and the worker are
        // unaffected.
        expect(sec[0]?.forced, `${table}: RLS must be FORCEd, not merely enabled`).toBe(true);

        const { rows: pol } = await client.query(
          `SELECT qual, with_check FROM pg_policies
            WHERE schemaname = 'public' AND tablename = $1 AND policyname = 'tenant_isolation'`,
          [table]
        );
        expect(pol.length, `${table}: tenant_isolation policy missing`).toBe(1);
        // Not merely "a policy exists" — USING (true) would satisfy that and
        // isolate nothing. The predicate has to be the tenant GUC.
        expect(pol[0].qual, `${table}: USING must filter on app.tenant_id`).toContain("app.tenant_id");
        expect(pol[0].with_check, `${table}: WITH CHECK must filter on app.tenant_id`).toContain(
          "app.tenant_id"
        );
      }
    } finally {
      await client.end();
    }
  });

  it("the request-time role cannot touch the locked tables", async () => {
    // These carry no tenantId, so the census above skips them — and the role
    // bootstrap grants every table to wezesha_app by default. That combination
    // left session tokens, password hashes and OAuth tokens readable by the role
    // every user request runs as. Assert both halves of the lock, because either
    // one alone can be undone by a later migration.
    const client = new Client({ connectionString: process.env.DIRECT_URL });
    await client.connect();
    try {
      for (const table of LOCKED_TABLES) {
        const { rows: grants } = await client.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE grantee = 'wezesha_app' AND table_schema = 'public' AND table_name = $1`,
          [table]
        );
        expect(
          grants.map((g) => g.privilege_type),
          `${table}: wezesha_app must hold no privileges on it`
        ).toEqual([]);

        const { rows: sec } = await client.query(
          `SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
          [table]
        );
        expect(sec[0]?.rowsecurity, `${table}: RLS must be enabled as the second lock`).toBe(true);
      }

      // User stays readable — the team screen reads member profiles through the
      // tenant client — but must not be writable by it.
      const { rows: userGrants } = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'wezesha_app' AND table_schema = 'public' AND table_name = 'User'`
      );
      expect(userGrants.map((g) => g.privilege_type).sort()).toEqual(["SELECT"]);
    } finally {
      await client.end();
    }
  });

  it("Tenant isolates on its own id", async () => {
    // The census keys on a tenantId column, which Tenant does not have, so it
    // was silently uncovered. Managed Postgres enables RLS on every public
    // table, where a missing policy reads as zero rows rather than an error —
    // so this gap surfaced as an app that resolved no workspace, not as a leak.
    const client = new Client({ connectionString: process.env.DIRECT_URL });
    await client.connect();
    try {
      // relforcerowsecurity as well as relrowsecurity, which is why this reads
      // pg_class rather than pg_tables: the census keys the FORCE sweep on a
      // tenantId column too, so Tenant was skipped there for the same reason it
      // was skipped here, and only the ENABLE half was ever asserted.
      const { rows: sec } = await client.query(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'Tenant'`
      );
      expect(sec[0]?.relrowsecurity, "Tenant: ROW LEVEL SECURITY must be enabled").toBe(true);
      expect(
        sec[0]?.relforcerowsecurity,
        "Tenant: ROW LEVEL SECURITY must be FORCEd — an owner is exempt from merely-enabled RLS, which is what a restore produces"
      ).toBe(true);

      const { rows: pol } = await client.query(
        `SELECT qual, with_check FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'Tenant' AND policyname = 'tenant_isolation'`
      );
      expect(pol.length, "Tenant: tenant_isolation policy missing").toBe(1);
      expect(pol[0].qual, "Tenant: policy must scope on id").toContain("app.tenant_id");
      expect(pol[0].with_check, "Tenant: policy must have WITH CHECK").toBeTruthy();
    } finally {
      await client.end();
    }
  });
});
