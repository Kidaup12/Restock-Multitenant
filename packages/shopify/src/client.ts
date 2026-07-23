/**
 * Minimal Admin GraphQL client over fetch. No @shopify/shopify-api SDK: the SDK
 * exists to manage authorization-code OAuth *sessions*; with offline tokens
 * stored per tenant, a signed POST per query is the whole protocol, and raw
 * fetch keeps the worker bundle small and the failure modes visible.
 *
 * Error taxonomy (what the caller must distinguish):
 *  - ShopifyRateLimitedError — HTTP 429 or GraphQL THROTTLED. Carries
 *    `retryAfterMs` (Retry-After header, or computed from the query-cost
 *    extension) so the job queue's backoff can respect the provider's pacing.
 *  - ShopifyAuthError — 401/403: token revoked or app uninstalled. Retrying is
 *    pointless; the caller should fail the sync and ask for a reconnect.
 *  - Error (generic) — transport failures after retries, other HTTP statuses,
 *    or GraphQL errors.
 */

export const SHOPIFY_API_VERSION = "2026-01";

export class ShopifyRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, detail: string) {
    super(`Shopify rate limited (retry after ${retryAfterMs}ms): ${detail}`);
    this.name = "ShopifyRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class ShopifyAuthError extends Error {
  constructor(status: number, shopDomain: string) {
    super(`Shopify auth failed (${status}) for ${shopDomain} — token revoked or app uninstalled`);
    this.name = "ShopifyAuthError";
  }
}

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: { currentlyAvailable?: number; restoreRate?: number };
    };
  };
};

export interface ShopifyClient {
  readonly shopDomain: string;
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_RETRY_AFTER_MS = 2000;

/** Retry-After header (seconds, possibly fractional) → ms; fallback 2s. */
function retryAfterFromHeader(res: Response): number {
  const raw = res.headers.get("Retry-After");
  const seconds = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : DEFAULT_RETRY_AFTER_MS;
}

/** THROTTLED cost extension → ms until enough budget restores; fallback 2s. */
function retryAfterFromCost(ext: GraphqlResponse<unknown>["extensions"]): number {
  const cost = ext?.cost;
  const requested = cost?.requestedQueryCost;
  const available = cost?.throttleStatus?.currentlyAvailable;
  const restoreRate = cost?.throttleStatus?.restoreRate;
  if (
    typeof requested === "number" &&
    typeof available === "number" &&
    typeof restoreRate === "number" &&
    restoreRate > 0 &&
    requested > available
  ) {
    return Math.ceil(((requested - available) / restoreRate) * 1000);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

export function createShopifyClient(opts: {
  shopDomain: string;
  accessToken: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}): ShopifyClient {
  const { shopDomain, accessToken } = opts;
  const apiVersion = opts.apiVersion ?? SHOPIFY_API_VERSION;
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  return {
    shopDomain,
    async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      // Up to 3 attempts on pure transport failures (a dropped connection
      // mid-backfill must not kill a long run). HTTP/GraphQL-level errors are
      // never retried here — that's the job queue's decision.
      let res: Response | undefined;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await doFetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken,
            },
            body: JSON.stringify({ query, variables }),
          });
          break;
        } catch (e) {
          lastErr = e;
          await sleep(1000 * (attempt + 1));
        }
      }
      if (!res) {
        throw new Error(
          `Shopify GraphQL transport failed after retries: ${(lastErr as Error)?.message ?? "unknown"}`
        );
      }

      if (res.status === 429) throw new ShopifyRateLimitedError(retryAfterFromHeader(res), "HTTP 429");
      if (res.status === 401 || res.status === 403) throw new ShopifyAuthError(res.status, shopDomain);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Shopify GraphQL HTTP ${res.status}: ${body.slice(0, 300)}`);
      }

      const json = (await res.json()) as GraphqlResponse<T>;
      if (json.errors?.length) {
        if (json.errors.some((e) => e.extensions?.code === "THROTTLED")) {
          throw new ShopifyRateLimitedError(retryAfterFromCost(json.extensions), "GraphQL THROTTLED");
        }
        throw new Error(`Shopify GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
      }
      if (json.data === undefined) throw new Error("Shopify GraphQL returned no data.");
      return json.data;
    },
  };
}
