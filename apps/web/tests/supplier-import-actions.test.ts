import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Supplier CSV import against the local database: what actually lands in the
 * table. Covers the manage_settings gate, the workspace-currency fallback, that
 * a second import updates instead of duplicating, that a blank cell leaves a
 * saved value alone, that a soft-deleted supplier is never resurrected by a
 * matching name, and that another tenant's supplier is neither matched nor
 * touched. Session + revalidation are stubbed; the database work is real.
 */

const url = process.env.SERVICE_DATABASE_URL ?? "";
const runnable = /localhost|127\.0\.0\.1/.test(url);

const authState = vi.hoisted(() => ({
  session: null as { user: { id: string; name: string | null; email: string } } | null,
  membership: null as
    | {
        tenantId: string;
        displayName: string | null;
        role: string;
        permissions: unknown;
        tenant: { currency: string };
      }
    | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => authState.session,
  activeMembership: async () => authState.membership,
}));

import { prismaForTenant, prismaService } from "@wezesha/db";
import {
  applySupplierImportAction,
  previewSupplierImportAction,
} from "../app/(shell)/suppliers/actions";

const SLUGS = ["supplier-import-a", "supplier-import-b"];

describe.skipIf(!runnable)("supplier CSV import (local db)", () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await prismaService.tenant.deleteMany({ where: { slug: { in: SLUGS } } });
    const a = await prismaService.tenant.create({
      data: { name: "Supplier Import A", slug: SLUGS[0]!, currency: "KES" },
    });
    const b = await prismaService.tenant.create({
      data: { name: "Supplier Import B", slug: SLUGS[1]!, currency: "USD" },
    });
    tenantA = a.id;
    tenantB = b.id;
  });

  afterAll(async () => {
    await prismaService.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prismaService.$disconnect();
  });

  beforeEach(async () => {
    await prismaService.auditEvent.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prismaService.supplier.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
  });

  function actAs(tenantId: string, permissions: unknown, currency = "KES") {
    authState.session = { user: { id: "actor-1", name: "Owner", email: "owner@example.test" } };
    authState.membership = {
      tenantId,
      displayName: "Owner",
      role: "OWNER",
      permissions,
      tenant: { currency },
    };
  }

  const suppliersOf = (tenantId: string) =>
    prismaForTenant(tenantId).supplier.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    });

  it("creates the file's suppliers, falling back to the workspace currency", async () => {
    actAs(tenantA, null, "KES");
    const csv =
      "Name,Email,Country,Lead time,Lead time variability,MOQ\n" +
      "Westgate Distributors,orders@westgate.co.ke,Kenya,14,3,24\n" +
      "Canton Supply,,China,35,7,48";

    const preview = await previewSupplierImportAction({ csv });
    expect(preview.ok && preview.data!.summary).toMatchObject({ total: 2, create: 2, update: 0 });
    // Preview writes nothing.
    expect(await suppliersOf(tenantA)).toHaveLength(0);

    const applied = await applySupplierImportAction({ csv });
    expect(applied.ok && applied.data).toMatchObject({ created: 2, updated: 0 });

    const rows = await suppliersOf(tenantA);
    expect(rows.map((r) => r.name)).toEqual(["Canton Supply", "Westgate Distributors"]);
    expect(rows.find((r) => r.name === "Westgate Distributors")).toMatchObject({
      email: "orders@westgate.co.ke",
      country: "Kenya",
      currency: "KES",
      leadTimeAvgDays: 14,
      leadTimeStdDays: 3,
      moq: 24,
    });

    const audits = await prismaForTenant(tenantA).auditEvent.findMany({
      where: { entity: "Supplier", action: "imported" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.meta).toMatchObject({ action: "supplier_import", created: 2, updated: 0 });
  });

  it("updates on a second import instead of creating a twin", async () => {
    actAs(tenantA, null);
    await applySupplierImportAction({ csv: "Name,MOQ\nWestgate Distributors,24" });
    const again = await applySupplierImportAction({ csv: "name,moq\n westgate distributors ,48" });

    expect(again.ok && again.data).toMatchObject({ created: 0, updated: 1 });
    const rows = await suppliersOf(tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.moq).toBe(48);
  });

  it("leaves a saved value alone when the file has no column for it", async () => {
    actAs(tenantA, null);
    await applySupplierImportAction({
      csv: "Name,Email,Lead time\nWestgate Distributors,orders@westgate.co.ke,14",
    });
    await applySupplierImportAction({ csv: "Name,MOQ\nWestgate Distributors,48" });

    const rows = await suppliersOf(tenantA);
    expect(rows[0]).toMatchObject({
      email: "orders@westgate.co.ke",
      leadTimeAvgDays: 14,
      moq: 48,
    });
  });

  it("never matches a soft-deleted supplier — it creates a live one instead", async () => {
    actAs(tenantA, null);
    await prismaService.supplier.create({
      data: { tenantId: tenantA, name: "Westgate Distributors", moq: 12, deletedAt: new Date() },
    });

    const applied = await applySupplierImportAction({ csv: "Name,MOQ\nWestgate Distributors,24" });
    expect(applied.ok && applied.data).toMatchObject({ created: 1, updated: 0 });

    const live = await suppliersOf(tenantA);
    expect(live).toHaveLength(1);
    expect(live[0]!.moq).toBe(24);
    // The removed row stays removed.
    const all = await prismaForTenant(tenantA).supplier.findMany({});
    expect(all.filter((s) => s.deletedAt !== null)).toHaveLength(1);
  });

  it("does not match or touch another tenant's supplier of the same name", async () => {
    actAs(tenantB, null, "USD");
    await applySupplierImportAction({ csv: "Name,MOQ,Currency\nWestgate Distributors,99,USD" });

    actAs(tenantA, null, "KES");
    const applied = await applySupplierImportAction({ csv: "Name,MOQ\nWestgate Distributors,24" });
    expect(applied.ok && applied.data).toMatchObject({ created: 1, updated: 0 });

    const a = await suppliersOf(tenantA);
    const b = await suppliersOf(tenantB);
    expect(a).toHaveLength(1);
    expect(a[0]!.moq).toBe(24);
    expect(a[0]!.currency).toBe("KES");
    expect(b).toHaveLength(1);
    expect(b[0]!.moq).toBe(99);
  });

  it("reports the unusable rows and imports the rest", async () => {
    actAs(tenantA, null);
    const applied = await applySupplierImportAction({
      csv: "Name,Lead time\nWestgate Distributors,14\n,9\nCanton Supply,soon\nWestgate Distributors,21",
    });
    expect(applied.ok && applied.data).toMatchObject({
      created: 1,
      updated: 0,
      invalid: 2,
      repeat: 1,
    });
    expect(await suppliersOf(tenantA)).toHaveLength(1);
  });

  it("rejects a member without manage_settings and writes nothing", async () => {
    actAs(tenantA, []);
    const result = await applySupplierImportAction({ csv: "Name\nWestgate Distributors" });
    expect(result).toEqual({
      ok: false,
      error: "You don't have settings access in this workspace.",
    });
    expect(await suppliersOf(tenantA)).toHaveLength(0);
  });
});
