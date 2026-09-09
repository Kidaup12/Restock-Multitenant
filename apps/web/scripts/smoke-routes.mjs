/**
 * Every page in the app, and how each one should be checked over HTTP.
 *
 * A separate module from `smoke.mjs` so the coverage test can read the lists
 * without executing the smoke run — importing the script itself would sign in
 * and start fetching.
 *
 * A marker is not decoration. A page that answers 200 and renders nothing
 * passes a status check and fails a person, so each route names a string only a
 * correct render produces. Where a screen has a "no workspace yet" branch, the
 * marker is deliberately taken from the REAL branch: the seeded owner has a
 * workspace, so landing on the empty state is a failure worth catching.
 */

/** Signed in, must render. */
export const ROUTES = [
  ["/today", "replenishment"],
  ["/plan", "Buy List"],
  ["/products", "Every product you sell"],
  ["/inventory", "Where your stock sits, branch by branch"],
  ["/insights", "Reports"],
  ["/orders", "every purchase order from draft to delivered"],
  ["/receiving", "Stock on its way in"],
  ["/suppliers", "Scorecard"],
  ["/transfers", "Even out cover between branches"],
  ["/costs", "cost comes from"],
  ["/sales", "Sales data"],
  ["/activity", "Who created, ordered, cancelled or received orders"],
  ["/profile", "Your account and workspace access"],
  ["/getting-started", "How Wezesha works"],
  ["/settings", "Workspace, team, and integrations"],
  ["/settings/connections", "Data sources connected to this workspace"],
  ["/settings/locations", "Tell us what each location does"],
  ["/settings/notifications", "Which messages this workspace sends to you"],
  ["/settings/ordering-strategy", "How Wezesha sizes your reorders"],
  ["/settings/plan", "what each plan includes"],
  ["/settings/pos", "Send what you sell over the counter"],
  ["/settings/signals", "normal trading"],
  // Not the member count: production runs a single-member workspace and says
  // "1 person has access", so the plural was a marker that only held on seeded
  // data. The invite heading is there whatever the team looks like.
  ["/settings/team", "Invite a teammate"],
  ["/settings/workspace", "the clock every sales day is measured against"],
  ["/workspaces/new", "One workspace per shop"],
];

/** No session needed. */
export const PUBLIC = [
  ["/login", "Welcome back"],
  ["/login/code", "Sign in with a code"],
  ["/signup", "Create account"],
  ["/forgot-password", "Forgot password"],
  ["/reset-password", "Reset password"],
  ["/pricing", "Priced per shop"],
  ["/contact", "Talk to a person"],
  ["/terms", "Merchant terms"],
  ["/privacy", "Privacy policy"],
  // A token that cannot exist. The page must say so rather than break — the
  // link in a stale email is the commonest way this route is reached.
  ["/invite/not-a-real-invite-token", "Invite not available"],
];

/** Must forward, not render. `/stock` shipped and was split into two screens;
 *  a bookmark must still land somewhere useful. */
export const REDIRECTS = [
  ["/", "/today"],
  ["/stock", "/products"],
  ["/stock/some-product-id", "/products/some-product-id"],
];

/**
 * Detail pages, whose ids only the data knows. Each is found by following a
 * link from its list page — which also proves the list links there at all. A
 * hand-written id would rot with the seed; a missing link is itself a defect.
 */
export const DYNAMIC = [
  {
    // From the dashboard, not the catalogue: /products only links a product to
    // its own page from inside an expanded row, so a server-rendered catalogue
    // carries no such href. Worth knowing — it is also the only way in.
    route: "/products/[productId]",
    from: "/today",
    pattern: /href="(\/products\/[A-Za-z0-9_-]{8,})"/,
    marker: "What the last run decided",
  },
  {
    route: "/orders/[id]",
    from: "/orders",
    pattern: /href="(\/orders\/[A-Za-z0-9_-]{8,})"/,
    marker: "Purchase order",
  },
  {
    route: "/orders/[id]/print",
    from: "/orders",
    pattern: /href="(\/orders\/[A-Za-z0-9_-]{8,})"/,
    suffix: "/print",
    marker: "Purchase order",
  },
  {
    route: "/suppliers/[id]/products",
    from: "/suppliers",
    pattern: /href="(\/suppliers\/[A-Za-z0-9_-]{8,}\/products)"/,
    marker: "Supplier",
  },
];

/**
 * The operator console. A signed-in shop owner is not a platform admin, so the
 * pass condition is that these do NOT show their contents — and equally that
 * they do not fall over. Both halves matter: a 500 here is a defect, and a
 * rendered fleet table would be a cross-tenant leak.
 */
/**
 * The operator console.
 *
 * Who may see it depends on the environment, so the expectation is derived
 * rather than hard-coded: `PlatformAdmin` is the allow-list, and `ADMIN_EMAILS`
 * is a bootstrap that answers "who is an admin while the table has no row" so a
 * fresh deploy is not locked out of its own console. On a seeded machine the
 * table is empty and the smoke account is usually on that list — so asserting
 * "withheld" would fail for the right reason and teach us to ignore it.
 *
 * Either way the two halves that matter hold: it must not fall over, and it
 * must not show a shop owner another shop's data.
 */
export const ADMIN = [
  ["/admin", "Staleness"],
  ["/admin/audit", "Actor"],
];

/**
 * Refused when addressed bare.
 *
 * The step-up prompt exists to confirm entering a named workspace, so it wants
 * `?enter=<tenantId>` and 404s without one — it is not a page you can visit.
 * The per-tenant view is the same: an id that names no customer workspace is a
 * 404, not an error. A 404 rather than a 403 throughout, so the surface does
 * not advertise itself to anyone probing paths.
 */
export const GUARDED = [
  ["/admin/step-up", 404],
  ["/admin/tenant/some-tenant-id", 404],
];

/** Every route this module accounts for, as an app-router path with its
 *  bracketed segments intact — the shape the coverage test compares against
 *  the filesystem. */
export function coveredRoutes() {
  return [
    ...ROUTES.map(([p]) => p),
    ...PUBLIC.map(([p]) => (p.startsWith("/invite/") ? "/invite/[token]" : p)),
    ...REDIRECTS.map(([p]) => (p === "/stock/some-product-id" ? "/stock/[productId]" : p)),
    ...DYNAMIC.map((d) => d.route),
    ...ADMIN.map(([p]) => p),
    ...GUARDED.map(([p]) =>
      String(p).startsWith("/admin/tenant/") ? "/admin/tenant/[id]" : String(p)
    ),
  ];
}
