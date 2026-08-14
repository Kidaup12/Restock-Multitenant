import { describe, it } from "vitest";
import { RuleTester } from "eslint";
// @ts-expect-error — plain-JS plugin, no declaration file (linted, not typechecked)
import tenantSafety from "./index.mjs";

/** RuleTester proof for the tenant-safety tripwire: fires on un-scoped
 *  service-client reads, aggregates and bulk writes, and on bare tenant
 *  lookups; silent on scoped queries, single-row writes, and non-service
 *  clients (prismaForTenant is RLS-confined). */

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

  it("covers the OrThrow reads, the aggregates, and the bulk writes", () => {
    tester.run("require-tenant-scope", rule, {
      valid: [
        // A compound unique key names the tenant one level down.
        "prismaService.product.findUniqueOrThrow({ where: { tenantId_sku: { tenantId, sku } } });",
        "prismaService.product.findFirstOrThrow({ where: { tenantId, sku } });",
        "prismaService.product.count({ where: { tenantId } });",
        "prismaService.salesHistory.aggregate({ where: { tenantId }, _sum: { units: true } });",
        "prismaService.salesHistory.groupBy({ by: ['productId'], where: { tenantId } });",
        "prismaService.product.updateMany({ where: { tenantId }, data });",
        "prismaService.salesHistory.deleteMany({ where: { tenantId, channel: 'shopify' } });",
      ],
      invalid: [
        {
          code: "prismaService.product.findUniqueOrThrow({ where: { id } });",
          errors: [
            { message: "prismaService.product.findUniqueOrThrow() must filter by tenantId." },
          ],
        },
        {
          code: "prismaService.product.findFirstOrThrow({ where: { sku } });",
          errors: [
            { message: "prismaService.product.findFirstOrThrow() must filter by tenantId." },
          ],
        },
        {
          code: "prismaService.product.count();",
          errors: [{ message: "prismaService.product.count() must filter by tenantId." }],
        },
        {
          code: "prismaService.salesHistory.aggregate({ _sum: { units: true } });",
          errors: [{ message: "prismaService.salesHistory.aggregate() must filter by tenantId." }],
        },
        {
          code: "prismaService.salesHistory.groupBy({ by: ['productId'] });",
          errors: [{ message: "prismaService.salesHistory.groupBy() must filter by tenantId." }],
        },
        {
          code: "prismaService.product.updateMany({ where: { source: 'shopify' }, data });",
          errors: [{ message: "prismaService.product.updateMany() must filter by tenantId." }],
        },
        {
          // The worst case in the system: this deletes another tenant's rows.
          code: "prismaService.salesHistory.deleteMany({ where: { channel: 'shopify' } });",
          errors: [{ message: "prismaService.salesHistory.deleteMany() must filter by tenantId." }],
        },
        {
          code: "prismaService.product.deleteMany();",
          errors: [{ message: "prismaService.product.deleteMany() must filter by tenantId." }],
        },
      ],
    });
  });

  it("requires upsert to scope both the lookup and the row it creates", () => {
    tester.run("require-tenant-scope", rule, {
      valid: [
        "prismaService.ingestCursor.upsert({ where: { tenantId_source: { tenantId, source } }, create: { tenantId, source }, update: { cursor } });",
        // A relation connect carries the tenant just as well as a scalar.
        "prismaService.location.upsert({ where: { tenantId_externalId: { tenantId, externalId } }, create: { tenant: { connect: { id: tenantId } }, externalId }, update: {} });",
      ],
      invalid: [
        {
          code: "prismaService.ingestCursor.upsert({ where: { source }, create: { tenantId, source }, update: {} });",
          errors: [{ message: "prismaService.ingestCursor.upsert() must filter by tenantId." }],
        },
        {
          // Scoped lookup, un-scoped insert: writes a row belonging to nobody.
          code: "prismaService.ingestCursor.upsert({ where: { tenantId_source: { tenantId, source } }, create: { source }, update: {} });",
          errors: [
            { message: "prismaService.ingestCursor.upsert() must set tenantId on the created row." },
          ],
        },
      ],
    });
  });

  it("treats the tenant table's own id as its scope key", () => {
    tester.run("require-tenant-scope", rule, {
      valid: ["prismaService.tenant.deleteMany({ where: { id: tenantId } });"],
      invalid: [
        {
          code: "prismaService.tenant.deleteMany({ where: { active: false } });",
          errors: [{ message: "prismaService.tenant.deleteMany() must filter by id." }],
        },
        {
          code: "prismaService.tenant.findUniqueOrThrow({ where: { id } });",
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

  it("exempts the files that define the clients", () => {
    tester.run("require-tenant-scope", rule, {
      valid: [
        {
          code: "prismaService.product.deleteMany();",
          filename: "/repo/packages/db/src/client.ts",
        },
        {
          code: "prismaService.tenant.findFirst();",
          filename: "/repo/packages/db/src/index.ts",
        },
      ],
      invalid: [
        {
          // Any other file in the package is a consumer like anywhere else.
          code: "prismaService.product.deleteMany();",
          filename: "/repo/packages/db/src/tenant-context.ts",
          errors: [{ message: "prismaService.product.deleteMany() must filter by tenantId." }],
        },
      ],
    });
  });

  it("follows an aliased import of the service client", () => {
    tester.run("require-tenant-scope", rule, {
      valid: [
        "import { prismaService as svc } from '@wezesha/db';\nsvc.product.deleteMany({ where: { tenantId } });",
        // A local named prismaService that isn't the service client still trips
        // the rule; an unrelated alias of something else does not.
        "import { prismaForTenant as svc } from '@wezesha/db';\nsvc.product.deleteMany();",
      ],
      invalid: [
        {
          code: "import { prismaService as svc } from '@wezesha/db';\nsvc.product.deleteMany();",
          errors: [{ message: "prismaService.product.deleteMany() must filter by tenantId." }],
        },
      ],
    });
  });

  it("does not read an exclusion or a disjunction as a scope", () => {
    // `NOT: { id: t }` names the scope key while meaning its exact inverse —
    // every tenant except this one. One level of nesting exists for compound
    // keys and `AND`, and those two keys alone; a filter that inverts or splits
    // the branch it names is not a scope.
    tester.run("require-tenant-scope", rule, {
      valid: [
        // The two shapes the one level of nesting exists for. If either of
        // these starts reporting, the exclusion has been drawn too wide.
        "prismaService.product.findUniqueOrThrow({ where: { tenantId_sku: { tenantId, sku } } });",
        "prismaService.product.findMany({ where: { AND: [{ tenantId }] } });",
        // An exclusion or a disjunction is fine beside a tenant named at the
        // top level — the scope is the outer key, not the branch.
        "prismaService.product.findMany({ where: { tenantId, NOT: { id } } });",
        "prismaService.salesHistory.deleteMany({ where: { tenantId, channel: 'pos', OR: rows } });",
      ],
      invalid: [
        {
          code: "prismaService.tenant.findMany({ where: { slug, NOT: { id: t } } });",
          errors: [{ message: "prismaService.tenant.findMany() must filter by id." }],
        },
        {
          code: "prismaService.product.findMany({ where: { NOT: { tenantId: t } } });",
          errors: [{ message: "prismaService.product.findMany() must filter by tenantId." }],
        },
        {
          // Only one branch names the tenant, so the other selects rows it
          // does not own.
          code: "prismaService.product.findMany({ where: { OR: [{ tenantId }, { sku }] } });",
          errors: [{ message: "prismaService.product.findMany() must filter by tenantId." }],
        },
        {
          code: "prismaService.order.findFirst({ where: { lines: { none: { tenantId } } } });",
          errors: [{ message: "prismaService.order.findFirst() must filter by tenantId." }],
        },
      ],
    });
  });

  it("covers the single-row writes, not just the bulk ones", () => {
    // The gap a 2026-08-11 audit found: on the BYPASSRLS client an update or
    // delete keyed only on an id is invisible to RLS, and was invisible here
    // too — the one combination with no second guard behind it.
    tester.run("require-tenant-scope", rule, {
      valid: [
        "prismaService.product.update({ where: { id, tenantId }, data: { costKes } });",
        "prismaService.product.delete({ where: { tenantId_sku: { tenantId, sku } } });",
      ],
      invalid: [
        {
          code: "prismaService.product.update({ where: { id }, data: { costKes } });",
          errors: [{ message: "prismaService.product.update() must filter by tenantId." }],
        },
        {
          code: "prismaService.product.delete({ where: { id } });",
          errors: [{ message: "prismaService.product.delete() must filter by tenantId." }],
        },
      ],
    });
  });
});
