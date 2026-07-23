import { timingSafeEqual } from "node:crypto";

export interface SocketPrincipal {
  tenantId: string;
}

/**
 * The auth seam. The gateway calls this with the raw credential from the
 * connection (query `?token=`, `Authorization: Bearer`, or the Better Auth
 * session cookie); a non-null result binds the socket to exactly that tenant,
 * null closes it with 4401. Swapping auth integrations means replacing only
 * the function wired in `index.ts` — the gateway itself depends on nothing but
 * this signature.
 */
export type AuthorizeSocket = (token: string) => Promise<SocketPrincipal | null>;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Dev-only stub: accepts `{secret}:{tenantId}` where the secret part must match
 * the WS_DEV_TOKEN env (e.g. WS_DEV_TOKEN=devtoken → `devtoken:tenant-a`).
 * With no shared secret configured, every token is rejected — fail closed.
 */
export function devAuthorizeSocket(sharedSecret: string | undefined): AuthorizeSocket {
  return async (token) => {
    if (!sharedSecret) return null;
    const sep = token.indexOf(":");
    if (sep <= 0) return null;
    const secret = token.slice(0, sep);
    const tenantId = token.slice(sep + 1);
    if (!tenantId || !safeEqual(secret, sharedSecret)) return null;
    return { tenantId };
  };
}

/** The two lookups session auth needs; injected so tests can fake the store
 *  and production wires the Prisma-backed one below. */
export interface SessionStore {
  /** Session row for a raw token, or null when unknown. */
  sessionByToken(token: string): Promise<{ userId: string; expiresAt: Date } | null>;
  /** The user's membership tenant ids, earliest membership first. */
  membershipTenantIds(userId: string): Promise<string[]>;
}

/**
 * Picks the socket's tenant from the user's memberships (earliest first).
 * The default takes the first — the single-workspace assumption. Workspace
 * selection later means passing a different picker, e.g. one that reads a
 * requested workspace off the connection and validates it against this list.
 */
export type SelectTenantId = (tenantIds: string[]) => string | null;

const firstTenant: SelectTenantId = (tenantIds) => tenantIds[0] ?? null;

/**
 * Real session auth: validates the credential against the Better Auth session
 * table and resolves the tenant via Membership. Accepts either the raw session
 * token or a signed cookie value (`{token}.{signature}` — possession of the
 * token is the credential; the DB lookup is the validation).
 */
export function sessionAuthorizeSocket(
  store: SessionStore,
  selectTenantId: SelectTenantId = firstTenant
): AuthorizeSocket {
  return async (token) => {
    const raw = token.split(".")[0] ?? "";
    if (!raw) return null;
    const session = await store.sessionByToken(raw);
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    const tenantId = selectTenantId(await store.membershipTenantIds(session.userId));
    return tenantId ? { tenantId } : null;
  };
}

/** Prisma-backed store on the service client (session + membership resolution
 *  is system scope — it happens before any tenant context exists). Loaded
 *  lazily so importing this module never requires database env. */
export function prismaSessionStore(): SessionStore {
  const service = () => import("@wezesha/db").then((db) => db.prismaService);
  return {
    async sessionByToken(token) {
      return (await service()).session.findUnique({
        where: { token },
        select: { userId: true, expiresAt: true },
      });
    },
    async membershipTenantIds(userId) {
      const memberships = await (await service()).membership.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { tenantId: true },
      });
      return memberships.map((m) => m.tenantId);
    },
  };
}
