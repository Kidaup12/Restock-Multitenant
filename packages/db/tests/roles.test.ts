import { describe, expect, it } from "vitest";
import { Client } from "pg";

/** The role-bootstrap migration must leave both app roles in place with the
 *  right attributes — wezesha_app RLS-bound, wezesha_service bypassing. */
describe("rls role bootstrap", () => {
  it("created wezesha_app (no bypass) and wezesha_service (bypass)", async () => {
    const client = new Client({ connectionString: process.env.DIRECT_URL });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT rolname, rolcanlogin, rolbypassrls, rolsuper
           FROM pg_roles WHERE rolname IN ('wezesha_app', 'wezesha_service')
           ORDER BY rolname`
      );
      expect(rows).toEqual([
        { rolname: "wezesha_app", rolcanlogin: true, rolbypassrls: false, rolsuper: false },
        { rolname: "wezesha_service", rolcanlogin: true, rolbypassrls: true, rolsuper: false },
      ]);
    } finally {
      await client.end();
    }
  });
});
