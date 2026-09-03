/**
 * HTTP smoke: does every main page actually RENDER, over the wire?
 *
 * The vitest suite renders server components with renderToStaticMarkup, which
 * does not enforce React's server→client serialisation boundary. An
 * unserialisable prop passed from a server component to a client one builds
 * clean, passes every unit test, and returns a 500 with the error boundary the
 * moment a real request hits the page. That is exactly how /inventory shipped
 * broken while 1423 tests were green (commit aefd2e3).
 *
 * No browser: better-auth issues a session cookie over the API, and the break
 * is a 500 plus the error-boundary string — both visible to fetch. Run against
 * a built `next start` server on a seeded database.
 *
 *   BASE=http://localhost:3000 node scripts/smoke.mjs
 */

const BASE = process.env.BASE ?? "http://localhost:3000";
const EMAIL = process.env.SMOKE_EMAIL ?? "owner@wezesha.test";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "Owner12345!";

// The authenticated pages a break would take down, each with a string only a
// correct render produces — so a page that 200s but renders empty still fails.
const ROUTES = [
  ["/today", "replenishment"],
  ["/products", "Every product"],
  ["/inventory", "Inventory"],
  ["/insights", "Wezesha"],
  ["/plan", "Buy List"],
  ["/orders", "Purchase orders"],
  ["/suppliers", "Suppliers"],
  ["/receiving", "Receiving"],
  ["/transfers", "Transfers"],
  ["/costs", "Costs"],
  ["/sales", "Sales"],
  ["/settings", "Settings"],
  ["/getting-started", "How Wezesha works"],
];

// Public pages need no session — cheap extra coverage.
const PUBLIC = [
  ["/login", "Welcome back"],
  ["/pricing", "Priced per shop"],
  ["/contact", "Talk to a person"],
];

const ERROR_MARKERS = ["Something went wrong", "Application error", "digest"];

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exitCode = 1;
}

async function signIn() {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in returned ${res.status}`);
  const cookie = res.headers.getSetCookie?.().join("; ") ?? res.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-in returned no session cookie");
  return cookie;
}

async function checkRoute(path, marker, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  const status = res.status;
  if (status >= 500) return fail(`${path} returned ${status}`);
  // An authenticated route bouncing to /login (3xx) means the cookie did not
  // take — a real failure for this smoke, not a pass.
  if (cookie && status >= 300 && status < 400) return fail(`${path} redirected (${status}) — not authenticated`);
  const body = await res.text();
  for (const m of ERROR_MARKERS) {
    if (body.includes(m)) return fail(`${path} rendered the error boundary ("${m}")`);
  }
  if (!body.includes(marker)) return fail(`${path} did not render its content ("${marker}" missing)`);
  console.log(`  ok  ${path} (${status})`);
}

const cookie = await signIn();
console.log("signed in; checking authenticated routes");
for (const [path, marker] of ROUTES) await checkRoute(path, marker, cookie);
console.log("checking public routes");
for (const [path, marker] of PUBLIC) await checkRoute(path, marker, null);

if (process.exitCode) console.error("\nSMOKE FAILED — a page did not render over HTTP");
else console.log("\nsmoke passed: every page renders over the wire");
