import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PLATFORM_TENANT_ID, PLATFORM_TENANT_SLUG } from "../src/platform-tenant";

/**
 * The escalation proof.
 *
 * A database-backed admin list is a privilege-escalation target in a way an env
 * var never was: any code path that can write PlatformAdmin reaches every
 * workspace's costs, suppliers and sales. The grants census next door reads the
 * catalog; this reads the outcome — it connects as `wezesha_app`, the role every
 * user request actually runs as, and tries to do the thing an attacker would.
 *
 * Both halves are asserted separately because they fail independently: a REVOKE
 * can be undone by a later ALTER DEFAULT PRIVILEGES sweep, and an RLS policy can
 * be added by a migration that means well.
 */

const dbUrl = process.env.DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl);

describe.skipIf(!runnable)("PlatformAdmin is unreachable by the request-time role", () => {
  let app: Client;

  beforeAll(async () => {
    app = new Client({ connectionString: dbUrl });
    await app.connect();
  });

  afterAll(async () => {
    await app.end();
  });

  it("cannot read the admin list", async () => {
    await expect(app.query(`SELECT * FROM "PlatformAdmin"`)).rejects.toThrow(
      /permission denied/i
    );
  });

  it("cannot grant itself admin", async () => {
    // The whole attack in one statement: tenant-scoped code that has been
    // tricked into running an INSERT of the attacker's choosing.
    await expect(
      app.query(
        `INSERT INTO "PlatformAdmin" ("id", "userId", "email") VALUES ($1, $2, $3)`,
        ["escalation-attempt", "escalation-attempt", "attacker@example.test"]
      )
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot revoke an existing admin", async () => {
    await expect(
      app.query(`UPDATE "PlatformAdmin" SET "revokedAt" = now()`)
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot delete the trail", async () => {
    await expect(app.query(`DELETE FROM "PlatformAdmin"`)).rejects.toThrow(
      /permission denied/i
    );
  });

  it("holds no privileges on the table and has RLS as the second lock", async () => {
    // Read the catalog through the owner role — wezesha_app cannot see its own
    // grants on a table it holds none on.
    const owner = new Client({ connectionString: process.env.DIRECT_URL });
    await owner.connect();
    try {
      const { rows: grants } = await owner.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'wezesha_app' AND table_schema = 'public'
            AND table_name = 'PlatformAdmin'`
      );
      expect(grants.map((g) => g.privilege_type)).toEqual([]);

      const { rows: sec } = await owner.query<{ rowsecurity: boolean }>(
        `SELECT rowsecurity FROM pg_tables
          WHERE schemaname = 'public' AND tablename = 'PlatformAdmin'`
      );
      expect(sec[0]?.rowsecurity, "RLS must be enabled as the second lock").toBe(true);

      const { rows: pol } = await owner.query(
        `SELECT policyname FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'PlatformAdmin'`
      );
      expect(pol, "no policy: RLS with none denies every row to a non-BYPASSRLS role").toEqual([]);
    } finally {
      await owner.end();
    }
  });
});

describe.skipIf(!runnable)("the platform workspace", () => {
  it("exists, is flagged as a system tenant, and holds no members", async () => {
    const owner = new Client({ connectionString: process.env.DIRECT_URL });
    await owner.connect();
    try {
      const { rows } = await owner.query<{ slug: string; isSystem: boolean; members: string }>(
        `SELECT t."slug", t."isSystem",
                (SELECT count(*) FROM "Membership" m WHERE m."tenantId" = t."id") AS members
           FROM "Tenant" t WHERE t."id" = $1`,
        [PLATFORM_TENANT_ID]
      );
      const platform = rows[0];
      expect(platform, "the platform workspace must exist to anchor audit rows").toBeDefined();
      expect(platform?.slug).toBe(PLATFORM_TENANT_SLUG);
      expect(platform?.isSystem).toBe(true);
      // Memberless is what makes it unreachable: every tenant read resolves
      // through a membership.
      expect(Number(platform?.members), "the platform workspace must stay memberless").toBe(0);
    } finally {
      await owner.end();
    }
  });

  it("has a slug no customer name can generate", async () => {
    // workspaceSlug() strips everything outside [a-z0-9-], so no name a shop
    // types can produce underscores — the migration's insert can never lose a
    // race with a real workspace.
    expect(PLATFORM_TENANT_SLUG).toMatch(/_/);
  });
});
