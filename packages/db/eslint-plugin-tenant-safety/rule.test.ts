import { describe, it } from "vitest";
import { RuleTester } from "eslint";
// @ts-expect-error — plain-JS plugin, no declaration file (linted, not typechecked)
import tenantSafety from "./index.mjs";

/** RuleTester proof for the tenant-safety tripwire: fires on un-scoped
 *  service-client reads and bare tenant lookups; silent on scoped reads,
 *  writes, and non-service clients (prismaForTenant is RLS-confined). */

const rule = tenantSafety.rules["require-tenant-scope"];
const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

describe("tenant-safety/require-tenant-scope", () => {
  it("fires on un-scoped service-client reads and bare tenant lookups", () => {
    tester.run("require-tenant-scope", rule, {
      valid: [],
      invalid: [
        {
          code: "prismaService.product.findMany();",
          errors: [{ message: "prismaService.product.findMany() must filter by tenantId." }],
        },
        {
          code: 'prismaService.order.findFirst({ where: { status: "pending" } });',
          errors: [{ message: "prismaService.order.findFirst() must filter by tenantId." }],
        },
        {
          code: "prismaService.tenant.findFirst();",
          errors: [
            {
              message:
                "Resolve tenants through the sanctioned resolver — bare prismaService.tenant lookup is banned.",
            },
          ],
        },
        {
          // Banned even when filtered — resolution belongs in the resolver.
          code: "prismaService.tenant.findUnique({ where: { slug } });",
          errors: [
            {
              message:
                "Resolve tenants through the sanctioned resolver — bare prismaService.tenant lookup is banned.",
            },
          ],
        },
      ],
    });
  });

  it("stays quiet on scoped reads, writes, and non-service clients", () => {
    tester.run("require-tenant-scope", rule, {
      valid: [
        "prismaService.product.findMany({ where: { tenantId } });",
        "prismaService.order.findFirst({ where: { tenantId: id, status: 'pending' } });",
        // Not the service client — prismaForTenant results are RLS-confined.
        "db.product.findMany();",
        // Not a read method.
        "prismaService.auditEvent.create({ data });",
      ],
      invalid: [],
    });
  });
});
