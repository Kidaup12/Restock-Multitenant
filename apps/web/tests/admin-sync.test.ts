import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Admin sync trigger against the real route handler + local db + local redis:
 * enqueues through the shared no-overlap guard AND writes the audit row on
 * every press (blocked presses included — the log records the admin's action,
 * not the queue's mood). Skips without a local service connection + REDIS_URL.
 */

const dbUrl = process.env.SERVICE_DATABASE_URL ?? "";
const redisUrl = process.env.REDIS_URL;
const runnable = /localhost|127\.0\.0\.1/.test(dbUrl) && Boolean(redisUrl);

const ADMIN_EMAIL = "admin-sync-admin@example.test";
const PASSWORD = "admin-sync-pass-1";
const SLUG_LIVE = "admin-sync-live";
const SLUG_DEAD = "admin-sync-dead";
const base = "http://auth-flow.test";

describe.skipIf(!runnable)("admin sync trigger (real db + redis)", () => {
  let POST: (req: Request) => Promise<Response>;
  let prismaService: typeof import("@wezesha/db").prismaService;
  let cookie: string;
  let liveTenantId: string;
  let deadTenantId: string;
  let adminUserId: string;

  function syncRequest(tenantId: unknown): Request {
    return new Request(`${base}/api/admin/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ tenantId }),
    });
  }

  async function removeJob(tenantId: string): Promise<void> {
    const { Redis } = await import("ioredis");
    const { createSyncQueue, syncJobId } = await import("@wezesha/queue");
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const queue = createSyncQueue(connection);
    await (await queue.getJob(syncJobId({ tenantId, source: "shopify" })))?.remove().catch(() => {});
    await queue.close();
    await connection.quit();
  }

  // Same allowance as testTimeout in vitest.config.ts — fixture setup signs up
  // a real user (scrypt) against the real database.
  beforeAll(async () => {
    ({ prismaService } = await import("@wezesha/db"));
    ({ POST } = await import("../app/api/admin/sync/route"));

    await prismaService.user.deleteMany({ where: { email: ADMIN_EMAIL } });
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_LIVE, SLUG_DEAD] } } });

    const live = await prismaService.tenant.create({
      data: { name: "Admin Sync Live", slug: SLUG_LIVE },
    });
    liveTenantId = live.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId: liveTenantId,
        shopDomain: "admin-sync-live.myshopify.com",
        accessToken: "ciphertext",
        scopes: "read_products",
      },
    });

    const dead = await prismaService.tenant.create({
      data: { name: "Admin Sync Dead", slug: SLUG_DEAD },
    });
    deadTenantId = dead.id;
    await prismaService.shopifyConnection.create({
      data: {
        tenantId: deadTenantId,
        shopDomain: "admin-sync-dead.myshopify.com",
        accessToken: "ciphertext",
        scopes: "read_products",
        uninstalledAt: new Date(),
      },
    });

    const { POST: authPost } = await import("../app/api/auth/[...all]/route");
    const res = await authPost(
      new Request(`${base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD, name: "admin-sync" }),
      })
    );
    expect(res.status).toBe(200);
    cookie = /better-auth\.session_token=[^;]+/.exec(res.headers.get("set-cookie") ?? "")![0];

    // Admin through the mechanism, not the bootstrap: ADMIN_EMAILS only answers
    // while the PlatformAdmin table has no live row, so a suite that relied on
    // it would pass on an empty database and 404 on a real one.
    const admin = await prismaService.user.findFirstOrThrow({
      where: { email: ADMIN_EMAIL },
      select: { id: true },
    });
    adminUserId = admin.id;
    await prismaService.platformAdmin.create({
      data: { userId: adminUserId, email: ADMIN_EMAIL },
    });
  }, 30_000);

  afterAll(async () => {
    if (adminUserId) {
      await prismaService.platformAdmin.deleteMany({ where: { userId: adminUserId } });
    }
    if (liveTenantId) await removeJob(liveTenantId);
    // AuditEvent has no tenant FK (append-only ledger) — clear rows explicitly.
    const ids = [liveTenantId, deadTenantId].filter(Boolean);
    if (ids.length) {
      await prismaService.auditEvent.deleteMany({ where: { tenantId: { in: ids } } });
    }
    await prismaService.tenant.deleteMany({ where: { slug: { in: [SLUG_LIVE, SLUG_DEAD] } } });
    await prismaService.user.deleteMany({ where: { email: ADMIN_EMAIL } });
    await prismaService.$disconnect();
  }, 30_000);

  it("enqueues the tenant's sync and writes the audit row", async () => {
    const res = await POST(syncRequest(liveTenantId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: boolean; jobId: string };
    expect(body.enqueued).toBe(true);

    const { Redis } = await import("ioredis");
    const { createSyncQueue, syncJobId } = await import("@wezesha/queue");
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const queue = createSyncQueue(connection);
    const job = await queue.getJob(syncJobId({ tenantId: liveTenantId, source: "shopify" }));
    expect(job?.data).toEqual({ tenantId: liveTenantId, source: "shopify" });
    await queue.close();
    await connection.quit();

    const events = await prismaService.auditEvent.findMany({
      where: { tenantId: liveTenantId, action: "admin_sync_trigger" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entity: "AdminSync",
      entityId: liveTenantId,
      actorName: "admin-sync",
    });
    expect(events[0]!.meta).toMatchObject({ adminEmail: ADMIN_EMAIL, enqueued: true });
    expect(events[0]!.actorUserId).toBeTruthy();
  });

  it("reports the no-overlap guard's verdict on a second press — and still logs it", async () => {
    const res = await POST(syncRequest(liveTenantId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: boolean; state?: string };
    expect(body.enqueued).toBe(false);
    expect(body.state).toBeTruthy();

    const events = await prismaService.auditEvent.findMany({
      where: { tenantId: liveTenantId, action: "admin_sync_trigger" },
      orderBy: { createdAt: "asc" },
    });
    expect(events).toHaveLength(2);
    expect(events[1]!.meta).toMatchObject({ enqueued: false, blockedBy: body.state });
  });

  it("400s on an uninstalled connection without touching the queue or ledger", async () => {
    const res = await POST(syncRequest(deadTenantId));
    expect(res.status).toBe(400);
    expect(
      await prismaService.auditEvent.count({ where: { tenantId: deadTenantId } })
    ).toBe(0);
  });

  it("400s on an unknown tenant and on a missing tenantId", async () => {
    expect((await POST(syncRequest("no-such-tenant"))).status).toBe(400);
    expect((await POST(syncRequest(undefined))).status).toBe(400);
  });
});
