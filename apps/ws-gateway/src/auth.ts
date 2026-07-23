import { timingSafeEqual } from "node:crypto";

export interface SocketPrincipal {
  tenantId: string;
}

/**
 * The auth seam. The gateway calls this with the raw token from the connection
 * (query `?token=` or `Authorization: Bearer`); a non-null result binds the
 * socket to exactly that tenant, null closes it with 4401. Swapping in the real
 * auth integration later means replacing only the function wired in `index.ts` —
 * the gateway itself depends on nothing but this signature.
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
