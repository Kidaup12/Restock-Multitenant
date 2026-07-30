import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaService } from "@wezesha/db";
import { seedDev, type SeedResult } from "../../db/scripts/seed-dev";
import { runForecast } from "../src/run";
import { runBacktest } from "../src/backtest-run";
import { createOwnerPrior, listOwnerPriors, revokeOwnerPrior } from "../src/owner-priors";

/**
 * The trust layer against a seeded local database: cold-start borrow vs
 * too-new, owner priors moving the number, confidence words, explainParts
 * round-trip, walk-forward backtest rows + champion audit. Skips without a
 * local database.
 */

const runnable = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");

let seeded: SeedResult;
let tenantId: string;
let cantuNewId: string;
let orphanNewId: string;

describe.skipIf(!runnable)("forecast-run trust layer (seeded local db)", () => {
  beforeAll(async () => {
    delete process.env.REDIS_URL; // publish degrades to a no-op
    seeded = await seedDev();
    tenantId = seeded.tenantId;

    // A cold-start product with an ESTABLISHED same-brand sibling (Cantu) → borrows.
    const cantuNew = await prismaService.product.create({
      data: {
        tenantId,
        sku: "CAN-NEW-999",
        title: "Cantu New Curl Serum 200ml",
        vendor: "Cantu",
        productType: "Hair Care",
        customCategory: "Hair",
        priceKes: 1700,
        costKes: 1050,
        costSource: "manual",
        currentStock: 0,
      },
    });
    cantuNewId = cantuNew.id;

    // A cold-start product with no similar established product → honest "too new".
    const orphan = await prismaService.product.create({
      data: {
        tenantId,
        sku: "ZZZ-NEW-999",
        title: "Obscure Widget Zero",
        vendor: "Zzz Unique",
        productType: "Widgets",
        customCategory: "Widgets",
        priceKes: 500,
        costKes: 300,
        costSource: "manual",
        currentStock: 0,
      },
    });
    orphanNewId = orphan.id;
  }, 120_000);

  afterAll(async () => {
    // Remove the two cold-start fixtures. They are added to the SHARED seeded
    // tenant, so leaving them behind raises its product count for every suite
    // that runs afterwards — a later run of apps/web then fails on a seeded
    // count nobody touched, in a workspace this one never loads.
    await prismaService.product.deleteMany({
      where: { tenantId, id: { in: [cantuNewId, orphanNewId] } },
    });
    await prismaService.$disconnect();
  });

  it("persists a confidence word and an explainParts breakdown on every prediction", async () => {
    await runForecast(tenantId);
    const predictions = await prismaService.prediction.findMany({ where: { tenantId } });
    expect(predictions.length).toBeGreaterThan(0);
    for (const p of predictions) {
      expect(["sure", "fairly_sure", "guessing"]).toContain(p.confidenceWord);
      expect(p.explainParts).not.toBeNull();
      const parts = p.explainParts as { recommendedQty: number };
      expect(parts.recommendedQty).toBe(Math.round(p.recommendedQty));
    }
  });

  it("cold start borrows from an established same-brand product, never a silent zero", async () => {
    await runForecast(tenantId);
    const p = await prismaService.prediction.findFirst({ where: { tenantId, productId: cantuNewId } });
    expect(p).not.toBeNull();
    expect(p!.coldStart).toBe("borrowed");
    expect(p!.borrowedFromProductId).not.toBeNull();
    expect(p!.finalForecast30d).toBeGreaterThan(0);
    expect(p!.confidenceWord).toBe("guessing");

    // The proxy is an ESTABLISHED product, never another new one.
    const proxy = await prismaService.product.findUnique({ where: { id: p!.borrowedFromProductId! } });
    expect(proxy).not.toBeNull();
    expect(proxy!.id).not.toBe(cantuNewId);
    expect(proxy!.id).not.toBe(orphanNewId);
  });

  it("a new product with no similar established product is honestly 'too new'", async () => {
    await runForecast(tenantId);
    const p = await prismaService.prediction.findFirst({ where: { tenantId, productId: orphanNewId } });
    expect(p!.coldStart).toBe("too_new");
    expect(p!.borrowedFromProductId).toBeNull();
    expect(p!.recommendedQty).toBe(0);
    expect(p!.confidenceWord).toBe("guessing");
    expect(p!.reasoning).toMatch(/too new/i);
  });

  it("an owner 'sell like' proxy overrides the auto choice", async () => {
    const cantuSibling = await prismaService.product.findFirst({
      where: { tenantId, sku: "CAN-SHE-340" },
    });
    const created = await createOwnerPrior(tenantId, {
      scope: "product",
      scopeValue: cantuNewId,
      proxyProductId: cantuSibling!.id,
      weeks: 6,
    });
    expect(created.ok).toBe(true);

    await runForecast(tenantId);
    const p = await prismaService.prediction.findFirst({ where: { tenantId, productId: cantuNewId } });
    expect(p!.coldStart).toBe("borrowed");
    expect(p!.borrowedFromProductId).toBe(cantuSibling!.id);

    // Clean up so later assertions aren't affected.
    if (created.ok) await revokeOwnerPrior(tenantId, created.id);
  });

  it("an owner expectation on an established product moves the number and shows it listened", async () => {
    const established = await prismaService.product.findFirst({ where: { tenantId, sku: "ARI-MJ-90" } });
    const created = await createOwnerPrior(tenantId, {
      scope: "product",
      scopeValue: established!.id,
      expectedUnits: 999,
      weeks: 4,
      createdByName: "Amara Dev",
    });
    expect(created.ok).toBe(true);

    await runForecast(tenantId);
    const p = await prismaService.prediction.findFirst({ where: { tenantId, productId: established!.id } });
    expect(p!.finalForecast30d).toBe(999); // owner figure, not capped
    const signals = JSON.parse(p!.signals) as Array<{ label: string }>;
    expect(signals.some((s) => /owner/i.test(s.label))).toBe(true);

    if (created.ok) await revokeOwnerPrior(tenantId, created.id);
  });

  it("lists and revokes owner priors", async () => {
    const established = await prismaService.product.findFirst({ where: { tenantId, sku: "NIV-PR-400" } });
    const created = await createOwnerPrior(tenantId, {
      scope: "brand",
      scopeValue: "Nivea",
      multiplier: 1.3,
      weeks: 4,
    });
    expect(created.ok).toBe(true);

    const active = await listOwnerPriors(tenantId, { activeOnly: true });
    expect(active.some((r) => r.scope === "brand" && r.scopeValue === "Nivea")).toBe(true);

    if (created.ok) {
      const revoked = await revokeOwnerPrior(tenantId, created.id);
      expect(revoked).toBe(true);
      const stillActive = await listOwnerPriors(tenantId, { activeOnly: true });
      expect(stillActive.some((r) => r.id === created.id)).toBe(false);
      const all = await listOwnerPriors(tenantId);
      expect(all.some((r) => r.id === created.id)).toBe(true); // listed, not deleted
    }
    void established;
  });

  it("runs a walk-forward backtest: rows by class + method, champion recorded", async () => {
    const outcome = await runBacktest(tenantId);
    expect(outcome.rowsWritten).toBeGreaterThan(0);

    const rows = await prismaService.backtestRun.findMany({
      where: { tenantId, tag: "walkforward" },
      orderBy: { runDate: "desc" },
    });
    expect(rows.length).toBeGreaterThan(0);
    // Units, not error %.
    for (const r of rows) {
      expect(r.saidUnits).not.toBeNull();
      expect(r.happenedUnits).not.toBeNull();
      expect(["over", "under", "even"]).toContain(r.leans!);
      expect(["A", "B", "C", "ALL"]).toContain(r.abcClass!);
      expect(["run_rate", "recent_heavy"]).toContain(r.method!);
    }
    // Champions recorded per class; run rate reigns by default.
    expect(outcome.champions).not.toBeNull();
    const config = await prismaService.tenantConfig.findUnique({ where: { tenantId } });
    const champs = config!.forecastChampions as Record<string, string>;
    expect(champs).toMatchObject({ A: expect.any(String), B: expect.any(String), C: expect.any(String) });
  });
});
