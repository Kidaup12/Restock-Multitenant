import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "../generated/client";
import { prismaForTenant, prismaService } from "../src/client";
import { builders, seedTwoTenants, type SeededTenants } from "./seed-two-tenants";

/**
 * REAL RLS enforcement proof (contract M1): connected as `wezesha_app`, the
 * DATABASE itself must confine every operation to the GUC's tenant — no
 * `where tenantId` discipline involved. The model list comes from the Prisma
 * DMMF, so every future tenant-scoped model is picked up automatically.
 */

// Destructive guard: the suite wipes and reseeds fixture tenants. FAIL (not
// skip) when pointed at a non-local database — a skipped M1 gate is a silent hole.
const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "");

const tenantModels = Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === "tenantId"))
  .map((m) => m.name);

type Delegate = {
  findMany: (a?: unknown) => Promise<Array<{ tenantId: string }>>;
  updateMany: (a: unknown) => Promise<{ count: number }>;
  deleteMany: (a: unknown) => Promise<{ count: number }>;
  create: (a: { data: unknown }) => Promise<unknown>;
};

const delegateFor = (client: unknown, model: string): Delegate => {
  const delegate = (client as Record<string, Delegate | undefined>)[
    model.charAt(0).toLowerCase() + model.slice(1)
  ];
  if (!delegate) throw new Error(`no client delegate for model ${model}`);
  return delegate;
};

let seeded: SeededTenants;

beforeAll(async () => {
  expect(local, "tenant-isolation suite must run against a local database").toBe(true);
  seeded = await seedTwoTenants();
});

afterAll(async () => {
  await prismaService.tenant.deleteMany({ where: { id: { in: [seeded.a.id, seeded.b.id] } } });
  // Fixture auth users are global — the tenant cascade doesn't reach them.
  await prismaService.user.deleteMany({ where: { id: { startsWith: "iso-user-" } } });
  await prismaService.$disconnect();
});

describe("fixture completeness", () => {
  it("every tenant-scoped model has a seed builder (update tests/seed-two-tenants.ts)", () => {
    const missing = tenantModels.filter((m) => !(m in builders));
    expect(missing).toEqual([]);
  });
});

describe.each(tenantModels)("RLS isolation — %s", (model) => {
  it("A-scoped read sees only A rows, and at least one", async () => {
    const rows = await delegateFor(prismaForTenant(seeded.a.id), model).findMany();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === seeded.a.id)).toBe(true);
  });

  it("A cannot read B's rows even when asking for them", async () => {
    const rows = await delegateFor(prismaForTenant(seeded.a.id), model).findMany({
      where: { tenantId: seeded.b.id },
    });
    expect(rows).toEqual([]);
  });

  it("A cannot update or delete B's rows", async () => {
    const scoped = delegateFor(prismaForTenant(seeded.a.id), model);
    const upd = await scoped.updateMany({ where: { tenantId: seeded.b.id }, data: { tenantId: seeded.b.id } });
    expect(upd.count).toBe(0);
    const del = await scoped.deleteMany({ where: { tenantId: seeded.b.id } });
    expect(del.count).toBe(0);
  });

  it("A cannot insert a row for B (WITH CHECK)", async () => {
    // Two refusals are correct here. WITH CHECK rejects the row outright; and
    // for a model that connects to Tenant, the Tenant policy hides B's tenant
    // row from A first, so Prisma reports the relation as missing before the
    // check is reached. Either way nothing is written, which is what the count
    // below actually proves — the message is incidental.
    const before = (await delegateFor(prismaForTenant(seeded.b.id), model).findMany()).length;
    const attempt = delegateFor(prismaForTenant(seeded.a.id), model).create({
      data: builders[model]!(seeded.b.id, "xchk"),
    });
    await expect(attempt).rejects.toThrow(/row-level security|records .* required but not found/i);
    const after = (await delegateFor(prismaForTenant(seeded.b.id), model).findMany()).length;
    expect(after, "no row may reach B's table").toBe(before);
  });

  it("fails closed: app role without a tenant GUC sees nothing", async () => {
    const bare = new PrismaClient(); // wezesha_app via DATABASE_URL, no GUC
    try {
      const rows = await delegateFor(bare, model).findMany();
      expect(rows).toEqual([]);
    } finally {
      await bare.$disconnect();
    }
  });
});
