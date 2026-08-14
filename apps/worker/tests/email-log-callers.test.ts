import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";

/**
 * The worker's two senders have to name the workspace they are mailing about.
 * Both already hold the tenant id — the alert is about that shop's sync, the
 * summary is that shop's week — so a null tenant on either row is a row the
 * shop's own export cannot show it.
 *
 * These run the real senders with their default seam (the suites elsewhere
 * inject a collector, which never reaches the ledger) and read the written row
 * back, so passing the wrong tenant fails here too.
 */

const redisUrl = process.env.REDIS_URL;
const localDb = /localhost|127\.0\.0\.1/.test(process.env.SERVICE_DATABASE_URL ?? "");
const runnable = Boolean(redisUrl) && localDb;

const SLUG = "worker-email-caller";
const ALERT_EMAIL = "worker-email-caller@example.test";

describe.skipIf(!runnable)("worker mail names its tenant and kind (real redis + db)", () => {
  let prismaService: typeof import("@wezesha/db").prismaService;
  let incident: typeof import("../src/incident");
  let crons: typeof import("../src/crons");
  let redis: Redis;
  let tenantId: string;

  const original = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };

  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    incident = await import("../src/incident");
    crons = await import("../src/crons");
    redis = new Redis(redisUrl!);

    await prismaService.tenant.deleteMany({ where: { slug: SLUG } });
    const tenant = await prismaService.tenant.create({
      data: {
        name: "Worker Email Caller",
        slug: SLUG,
        tenantConfig: { create: { alertEmail: ALERT_EMAIL } },
      },
    });
    tenantId = tenant.id;
  }, 30_000);

  afterAll(async () => {
    await redis.del(`incident:sync:${tenantId}:shopify`);
    await prismaService.emailLog.deleteMany({ where: { to: ALERT_EMAIL } });
    await prismaService.tenant.deleteMany({ where: { id: tenantId } });
    redis.disconnect();
    await prismaService.$disconnect();
  }, 30_000);

  beforeEach(async () => {
    // No provider key: the send takes the console fallback, which still writes
    // the envelope. The row is what these assert on, not the delivery.
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    vi.spyOn(console, "log").mockImplementation(() => {});
    await redis.del(`incident:sync:${tenantId}:shopify`);
    await prismaService.emailLog.deleteMany({ where: { to: ALERT_EMAIL } });
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = original.key;
    process.env.EMAIL_FROM = original.from;
    vi.restoreAllMocks();
  });

  /** The one row this send left, waiting briefly for a best-effort write. */
  async function row() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const rows = await prismaService.emailLog.findMany({ where: { to: ALERT_EMAIL } });
      if (rows.length > 0) {
        expect(rows).toHaveLength(1);
        return rows[0]!;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no EmailLog row was written for ${ALERT_EMAIL}`);
  }

  it("logs a reconnect alert against the workspace whose sync failed", async () => {
    const sent = await incident.sendIncidentAlert({
      redis,
      tenantId,
      source: "shopify",
      reason: "token expired",
    });
    expect(sent).toBe(true);

    const logged = await row();
    expect(logged.tenantId).toBe(tenantId);
    expect(logged.kind).toBe("reconnect_alert");
  });

  it("logs the weekly summary against the workspace it summarises", async () => {
    expect(await crons.sendWeeklySummary(tenantId)).toBe(true);

    const logged = await row();
    expect(logged.tenantId).toBe(tenantId);
    expect(logged.kind).toBe("weekly_summary");
  });
});
