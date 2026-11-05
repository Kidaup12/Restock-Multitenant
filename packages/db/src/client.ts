import { PrismaClient, Prisma } from "@prisma/client";

/**
 * Two-client multi-tenant data layer (RLS enforced from the first migration).
 *
 *  - `prismaForTenant(tenantId)` — RLS-ENFORCED client (connects as `wezesha_app`).
 *    Every operation runs inside a transaction that first sets the transaction-local
 *    `app.tenant_id` GUC, so Postgres Row Level Security filters every query to this
 *    tenant. Use this for all user-facing request paths.
 *
 *  - `prismaService` — RLS-BYPASS client (connects as `wezesha_service`). For system
 *    and cross-tenant paths that have no single tenant context: cron jobs, feeds,
 *    webhooks, the auth bootstrap, offline scripts — and ALL audit-ledger writes
 *    (an audit log the tenant role could filter is not an audit log).
 *
 * Why the transaction wrapper: under transaction-mode pooling a plain `SET` leaks
 * across recycled connections. A transaction-local GUC set in the SAME transaction
 * as the query is the only safe pattern — the array-form $transaction keeps both
 * statements on one pinned backend.
 *
 * Fail-closed: if the GUC is unset, `current_setting('app.tenant_id', true)` is
 * NULL, so RLS policies match no rows (reads → 0 rows, writes → rejected). A missed
 * conversion breaks a page (empty data); it never leaks another tenant's rows.
 *
 * The raw PrismaClient is deliberately not exported — every consumer goes through
 * one of the three functions below.
 */

/**
 * Pool sizing without editing the secret database URLs: when DB_CONNECTION_LIMIT
 * (and optionally DB_POOL_TIMEOUT, seconds) are set, they replace the URL's own
 * connection_limit / pool_timeout. The web app shipped with connection_limit=1,
 * and pages that run several queries at once (Reports, Sales) queued behind that
 * single connection until they timed out (P2024) while the hourly sync was
 * busy. Unset leaves the URL exactly as configured.
 */
export function withPoolSettings(url: string | undefined): string | undefined {
  const limit = process.env.DB_CONNECTION_LIMIT;
  if (!url || !limit) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("connection_limit", String(Math.max(1, Math.min(50, Number(limit) || 1))));
    u.searchParams.set("pool_timeout", String(Math.max(5, Number(process.env.DB_POOL_TIMEOUT) || 20)));
    return u.toString();
  } catch {
    return url; // not a URL we can parse — leave it to Prisma to report
  }
}

const globalForPrisma = globalThis as unknown as {
  basePrisma?: PrismaClient;
  prismaService?: PrismaClient;
};

// Base client → `wezesha_app` (RLS enforced). Module-private: never query without
// a tenant GUC. Exposed only through prismaForTenant / prismaForTenantTx.
const baseUrl = withPoolSettings(process.env.DATABASE_URL);
const basePrisma =
  globalForPrisma.basePrisma ?? (baseUrl ? new PrismaClient({ datasources: { db: { url: baseUrl } } }) : new PrismaClient());

// Service client → `wezesha_service` (BYPASSRLS). No fallback: a missing URL must
// fail loudly here, not silently run system paths against the RLS-bound role.
function makeServiceClient(): PrismaClient {
  const url = process.env.SERVICE_DATABASE_URL;
  if (!url) throw new Error("SERVICE_DATABASE_URL is not set (wezesha_service connection)");
  return new PrismaClient({ datasources: { db: { url: withPoolSettings(url) } } });
}
export const prismaService = globalForPrisma.prismaService ?? makeServiceClient();

// Auth-system client (Better Auth's Prisma adapter). Auth operations are
// global/system scope — the auth tables carry no tenantId and users span
// tenants — so the BYPASSRLS service connection is the correct one.
export const prismaAuth = prismaService;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.basePrisma = basePrisma;
  globalForPrisma.prismaService = prismaService;
}

/** RLS-enforced client scoped to one tenant. Each operation sets `app.tenant_id`
 *  transaction-locally first (see file header). */
function makeTenantClient(tenantId: string) {
  return basePrisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await basePrisma.$transaction([
            basePrisma.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

export function prismaForTenant(tenantId: string) {
  return makeTenantClient(tenantId);
}

export type TenantClient = ReturnType<typeof prismaForTenant>;

/** Multi-statement atomic work for one tenant: a single interactive transaction with
 *  the GUC set once. The callback gets the RAW tx client (not the per-op extended
 *  client), so its operations are not re-wrapped — avoids nested transactions.
 *
 *  Also the way to run a BATCH of reads on one connection: `prismaForTenant` opens
 *  a transaction per operation, so issuing N of them together asks the pool for N
 *  connections and starves itself wherever the pool is smaller (see
 *  packages/db/README.md on sizing `connection_limit`).
 *
 *  `options` are Prisma's interactive-transaction limits, and default to
 *  `maxWait 2s / timeout 5s`. Anything that holds the connection for longer than a
 *  request — a nightly batch, a bulk write — must raise `timeout` explicitly or it
 *  trades a pool timeout for a transaction one. */
export function prismaForTenantTx<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number }
): Promise<T> {
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }, options);
}
