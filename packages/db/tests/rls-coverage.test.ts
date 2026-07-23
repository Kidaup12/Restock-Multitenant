import { describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * Mechanical RLS coverage census against the live schema: a tenant table that
 * ships without its policy fails CI here, no human vigilance required.
 */

// Tables that are ALLOWED to have no tenantId column. Additions are a reviewed
// decision, not a default.
const GLOBAL_TABLES = [
  "Tenant",
  "_prisma_migrations",
  // Better Auth tables — users span tenants (Membership is the per-tenant link).
  "User",
  "Session",
  "Account",
  "Verification",
  // Shopify webhook dedupe ledger — keyed by the delivery id (X-Shopify-Webhook-Id),
  // which is checked before the tenant is even resolved; rows carry no tenant data.
  "WebhookEvent",
];

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
          `SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
          [table]
        );
        expect(sec[0]?.rowsecurity, `${table}: ROW LEVEL SECURITY must be enabled`).toBe(true);

        const { rows: pol } = await client.query(
          `SELECT qual, with_check FROM pg_policies
            WHERE schemaname = 'public' AND tablename = $1 AND policyname = 'tenant_isolation'`,
          [table]
        );
        expect(pol.length, `${table}: tenant_isolation policy missing`).toBe(1);
        expect(pol[0].qual, `${table}: policy must have USING`).toBeTruthy();
        expect(pol[0].with_check, `${table}: policy must have WITH CHECK`).toBeTruthy();
      }
    } finally {
      await client.end();
    }
  });
});
