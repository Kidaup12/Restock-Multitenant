import { Prisma, prismaForTenant } from "@wezesha/db";

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
 *
 * The trail is read one page at a time. It only ever grows, and a reader who
 * gets the newest page with no count cannot tell a complete log from a
 * truncated one.
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

/**
 * What each kind of record is called when it cannot be named.
 *
 * Every entity the app actually writes needs an entry: a missing one fell
 * through to "a record", and most of the ledger was written by entities this
 * map had never heard of.
 */
const ENTITY_NOUN: Record<string, string> = {
  PurchaseOrder: "a purchase order",
  Order: "an order",
  Product: "a product",
  Supplier: "a supplier",
  ShopifyConnection: "the Shopify connection",
  Tenant: "the workspace settings",
  TenantConfig: "the workspace settings",
  Shop: "the store record",
  Location: "a branch",
  LocationClosure: "a branch closure",
  DistributionPlan: "a transfer plan",
  Promo: "a promotion",
  Membership: "a team member",
};

const ACTION_VERB: Record<string, string> = {
  created: "created",
  edited: "edited",
  ordered: "marked as ordered",
  cancelled: "cancelled",
  received: "marked as received",
  deleted: "deleted",
  sent: "sent",
  finalised: "finalised",
  exported: "exported",
  settings_updated: "updated",
  plan_changed: "changed the plan on",
  terms_accepted: "accepted the terms for",
  owner_invited: "invited the owner of",
  role_confirmed: "confirmed the role of",
  closure_declared: "recorded",
  closure_removed: "removed",
  promo_declared: "recorded",
  promo_removed: "removed",
  pos_secret_rotated: "rotated the till key in",
  shopify_connected_with_token: "connected",
  shopify_app_credentials_saved: "saved credentials for",
  shopify_app_credentials_cleared: "removed credentials for",
  cost_import: "imported costs into",
  shop_redact: "erased data for",
};

/**
 * Entries that are not "someone did X to a record".
 *
 * Support opening a customer's workspace is written against THAT workspace, so
 * it lands in the shop's own log — which is right, and is the sort of thing an
 * accounting trail exists to record. It just has to say so in words: it read
 * "impersonation start — a record", which tells a shop nothing at all.
 */
const FULL_SENTENCE: Record<string, string> = {
  "AdminSession:impersonation_start": "Wezesha support opened this workspace",
  "AdminSession:impersonation_end": "Wezesha support closed this workspace",
  "AdminSync:admin_sync_trigger": "Wezesha support started a sync",
};

/** Human money, only ever built for a caller allowed to see it. */
function costDelta(meta: unknown, currency: string): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const m = meta as { from?: unknown; to?: unknown };
  if (typeof m.from !== "number" || typeof m.to !== "number") return null;
  return ` from ${currency} ${m.from.toLocaleString()} to ${currency} ${m.to.toLocaleString()}`;
}

function summarise(
  row: { entity: string; action: string; entityId: string; meta: unknown },
  canViewCosts: boolean,
  currency: string,
  names: Map<string, string>
): string {
  const full = FULL_SENTENCE[`${row.entity}:${row.action}`];
  if (full) return full;

  // The record itself when we can still resolve it, the generic noun when we
  // cannot — a deleted row, or one written before its id was recorded.
  const named = names.get(`${row.entity}:${row.entityId}`);
  const subject = named ?? ENTITY_NOUN[row.entity] ?? "a record";

  if (COST_ACTIONS.has(row.action)) {
    // Only reachable by a cost viewer — members never get these rows at all.
    const delta = canViewCosts ? costDelta(row.meta, currency) : null;
    return `Changed the cost of ${subject}${delta ?? ""}`;
  }

  const verb = ACTION_VERB[row.action];
  // An action we have not written copy for still shows up, readably, rather
  // than vanishing from a record that claims to be complete.
  if (!verb) return `${row.action.replace(/_/g, " ")} — ${subject}`;
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${subject}`;
}

/**
 * Resolve the page's rows to the things they happened to.
 *
 * The trail is presented as an accounting record — "who changed a cost" — and
 * could not answer "which product?". The ids were always there; only the
 * customer-facing screen dropped them, while the operator console rendered the
 * entity and id happily.
 *
 * One query per kind per page (50 rows), on the tenant-scoped client — so an id
 * belonging to another workspace resolves to nothing and the row degrades to its
 * generic noun rather than leaking a name. Same for anything since deleted,
 * which is exactly when a log is read.
 */
async function resolveNames(
  db: ReturnType<typeof prismaForTenant>,
  rows: { entity: string; entityId: string }[]
): Promise<Map<string, string>> {
  const idsByEntity = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.entityId || r.entityId === "-") continue;
    if (!idsByEntity.has(r.entity)) idsByEntity.set(r.entity, []);
    idsByEntity.get(r.entity)!.push(r.entityId);
  }
  const names = new Map<string, string>();
  const take = (entity: string) => [...new Set(idsByEntity.get(entity) ?? [])];

  const [products, suppliers, pos, locations, plans] = await Promise.all([
    take("Product").length
      ? db.product.findMany({
          where: { id: { in: take("Product") } },
          select: { id: true, title: true, sku: true },
        })
      : [],
    take("Supplier").length
      ? db.supplier.findMany({ where: { id: { in: take("Supplier") } }, select: { id: true, name: true } })
      : [],
    take("PurchaseOrder").length
      ? db.purchaseOrder.findMany({
          where: { id: { in: take("PurchaseOrder") } },
          select: { id: true, poNumber: true },
        })
      : [],
    take("Location").length
      ? db.location.findMany({ where: { id: { in: take("Location") } }, select: { id: true, name: true } })
      : [],
    take("DistributionPlan").length
      ? db.distributionPlan.findMany({
          where: { id: { in: take("DistributionPlan") } },
          select: { id: true, name: true },
        })
      : [],
  ]);

  // The SKU rides along on a product: two shelves of "Vaseline 400ml" is the
  // case where a title alone still cannot answer "which one?".
  for (const p of products) {
    names.set(`Product:${p.id}`, p.sku ? `${p.title} (${p.sku})` : p.title);
  }
  for (const s of suppliers) names.set(`Supplier:${s.id}`, s.name);
  for (const p of pos) names.set(`PurchaseOrder:${p.id}`, p.poNumber);
  for (const l of locations) names.set(`Location:${l.id}`, l.name);
  for (const p of plans) if (p.name) names.set(`DistributionPlan:${p.id}`, p.name);

  return names;
}

/**
 * Entries per page. The same 50 the catalogue uses, so the two long tables in
 * the app page identically — and each entry here is one line of text rather
 * than a row of computed figures, so a page of them is about two screens of
 * scrolling and costs almost nothing to send.
 */
export const ACTIVITY_PAGE_SIZE = 50;

/**
 * What a search term is matched against: the actor, and the plain words the row
 * prints. Someone looking for "who cancelled that order" types either the
 * person's role or the word on the entry, not the `cancelled` token or the
 * `PurchaseOrder` class — so a term matches the display noun and verb as well
 * as the raw column.
 *
 * `meta` is deliberately not searched. It holds the cost figures a money-blind
 * member must never learn, and a search over it hands them a way to confirm one
 * by watching the match count move.
 *
 * Terms are ANDed: "cancelled order" means both, in any order.
 */
function keysMatching(map: Record<string, string>, term: string): string[] {
  return Object.entries(map)
    .filter(([, phrase]) => phrase.toLowerCase().includes(term))
    .map(([key]) => key);
}

function searchFilter(search: string): Prisma.AuditEventWhereInput[] {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.map((term) => {
    const entities = keysMatching(ENTITY_NOUN, term);
    const actions = keysMatching(ACTION_VERB, term);
    return {
      OR: [
        { actorName: { contains: term, mode: "insensitive" as const } },
        { entity: { contains: term, mode: "insensitive" as const } },
        { action: { contains: term, mode: "insensitive" as const } },
        ...(entities.length ? [{ entity: { in: entities } }] : []),
        ...(actions.length ? [{ action: { in: actions } }] : []),
      ],
    };
  });
}

/** The one place the rows and the count agree on what the reader asked for. */
function activityWhere(canViewCosts: boolean, search: string): Prisma.AuditEventWhereInput {
  const and: Prisma.AuditEventWhereInput[] = [...searchFilter(search)];
  if (!canViewCosts) and.push({ action: { notIn: [...COST_ACTIONS] } });
  return and.length ? { AND: and } : {};
}

/** How many entries the reader's search matches — the whole trail, not the page.
 *  What the pager counts against, so "showing 1–50 of 123" is honest. */
export async function countActivity(
  tenantId: string,
  { canViewCosts, search = "" }: { canViewCosts: boolean; search?: string }
): Promise<number> {
  const db = prismaForTenant(tenantId);
  return db.auditEvent.count({ where: activityWhere(canViewCosts, search) });
}

export async function getActivity(
  tenantId: string,
  { canViewCosts, currency, search = "", page = 0 }: {
    canViewCosts: boolean;
    currency: string;
    search?: string;
    /** 0-based. */
    page?: number;
  }
): Promise<ActivityEntry[]> {
  const db = prismaForTenant(tenantId);
  const rows = await db.auditEvent.findMany({
    where: activityWhere(canViewCosts, search),
    // Id breaks a timestamp tie. Without it two entries written in the same
    // millisecond can swap places between requests, which on a page boundary
    // shows one of them twice and hides the other.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: Math.max(0, page) * ACTIVITY_PAGE_SIZE,
    take: ACTIVITY_PAGE_SIZE,
    select: {
      id: true,
      entity: true,
      entityId: true,
      action: true,
      actorName: true,
      meta: true,
      createdAt: true,
    },
  });

  const names = await resolveNames(db, rows);

  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt,
    actor: row.actorName,
    summary: summarise(row, canViewCosts, currency, names),
  }));
}
