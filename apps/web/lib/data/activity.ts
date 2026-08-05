import { prismaForTenant } from "@wezesha/db";

/**
 * The shop's own record of who did what — an append-only trail for accounting.
 *
 * The rows have always been written; they were only ever readable in the
 * operator console, so a shop could not answer "who cancelled that order?" or
 * "who changed this cost?" about its own workspace.
 *
 * Money-blindness is the sharp edge here. `meta` on a cost change holds the
 * actual figures (`{from: 500, to: 650}`), so raw meta must never reach a
 * client payload, and cost entries are dropped entirely for a money-blind
 * caller — the same treatment their notification feed already gets, and for the
 * same reason: the entry's presence is itself a statement about cost.
 */

/** Entity+action pairs that describe a money change. */
const COST_ACTIONS = new Set(["cost_changed", "price_changed"]);

export type ActivityEntry = {
  id: string;
  at: Date;
  /** Who did it; null for something the system did on the shop's behalf. */
  actor: string | null;
  /** One plain sentence. Never the raw action token, never raw meta. */
  summary: string;
};

const ENTITY_NOUN: Record<string, string> = {
  PurchaseOrder: "a purchase order",
  Order: "an order",
  Product: "a product",
  Supplier: "a supplier",
  ShopifyConnection: "the Shopify connection",
  Tenant: "the workspace settings",
  Shop: "the store record",
};

const ACTION_VERB: Record<string, string> = {
  created: "created",
  edited: "edited",
  ordered: "marked as ordered",
  cancelled: "cancelled",
  received: "marked as received",
  deleted: "deleted",
  sent: "sent",
  settings_updated: "updated",
  shopify_connected_with_token: "connected",
  shopify_app_credentials_saved: "saved credentials for",
  shop_redact: "erased data for",
};

/** Human money, only ever built for a caller allowed to see it. */
function costDelta(meta: unknown, currency: string): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const m = meta as { from?: unknown; to?: unknown };
  if (typeof m.from !== "number" || typeof m.to !== "number") return null;
  return ` from ${currency} ${m.from.toLocaleString()} to ${currency} ${m.to.toLocaleString()}`;
}

function summarise(
  row: { entity: string; action: string; meta: unknown },
  canViewCosts: boolean,
  currency: string
): string {
  const noun = ENTITY_NOUN[row.entity] ?? "a record";

  if (COST_ACTIONS.has(row.action)) {
    // Only reachable by a cost viewer — members never get these rows at all.
    const delta = canViewCosts ? costDelta(row.meta, currency) : null;
    return `Changed the cost of ${noun}${delta ?? ""}`;
  }

  const verb = ACTION_VERB[row.action];
  // An action we have not written copy for still shows up, readably, rather
  // than vanishing from a record that claims to be complete.
  if (!verb) return `${row.action.replace(/_/g, " ")} — ${noun}`;
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${noun}`;
}

export async function getActivity(
  tenantId: string,
  { canViewCosts, currency, limit = 100 }: {
    canViewCosts: boolean;
    currency: string;
    limit?: number;
  }
): Promise<ActivityEntry[]> {
  const db = prismaForTenant(tenantId);
  const rows = await db.auditEvent.findMany({
    where: canViewCosts ? {} : { action: { notIn: [...COST_ACTIONS] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, entity: true, action: true, actorName: true, meta: true, createdAt: true },
  });

  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt,
    actor: row.actorName,
    summary: summarise(row, canViewCosts, currency),
  }));
}
