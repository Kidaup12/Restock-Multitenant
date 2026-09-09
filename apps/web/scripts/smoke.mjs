/**
 * HTTP smoke: does every page actually RENDER, over the wire?
 *
 * The vitest suite renders server components with renderToStaticMarkup, which
 * does not enforce React's server→client serialisation boundary. An
 * unserialisable prop passed from a server component to a client one builds
 * clean, passes every unit test, and returns a 500 with the error boundary the
 * moment a real request hits the page. That is exactly how /inventory shipped
 * broken while 1423 tests were green.
 *
 * No browser: better-auth issues a session cookie over the API, and the break
 * is a 500 plus the error-boundary string — both visible to fetch. Run against
 * a built `next start` server on a seeded database.
 *
 *   BASE=http://localhost:3000 node scripts/smoke.mjs
 *
 * Every page in the app is accounted for in `smoke-routes.mjs`, in one of five
 * lists. `tests/smoke-route-coverage.test.ts` fails when a new page.tsx appears
 * in none of them, so a page added next month is red until someone decides how
 * it should be checked — rather than quietly never being loaded.
 */

import { ROUTES, PUBLIC, REDIRECTS, DYNAMIC, ADMIN, GUARDED } from "./smoke-routes.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const EMAIL = process.env.SMOKE_EMAIL ?? "owner@wezesha.test";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "Owner12345!";

import { crashed, redirectTarget } from "./smoke-detect.mjs";

let failures = 0;
function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  failures += 1;
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

async function get(path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

async function checkRoute(path, marker, cookie) {
  const { status, body } = await get(path, cookie);
  if (status >= 500) return fail(`${path} returned ${status}`);
  // An authenticated route bouncing to /login (3xx) means the cookie did not
  // take — a real failure for this smoke, not a pass.
  if (cookie && status >= 300 && status < 400) {
    return fail(`${path} redirected (${status}) — not authenticated`);
  }
  const crash = crashed(body);
  if (crash) return fail(`${path} rendered the error boundary (${crash})`);
  if (!body.includes(marker)) {
    return fail(`${path} did not render its content ("${marker}" missing)`);
  }
  console.log(`  ok  ${path} (${status})`);
}

async function checkRedirect(path, target, cookie) {
  const res = await get(path, cookie);
  if (res.status >= 500) return fail(`${path} returned ${res.status}`);
  const crash = crashed(res.body);
  if (crash) return fail(`${path} rendered the error boundary (${crash})`);
  const to = redirectTarget(res);
  if (!to) return fail(`${path} should forward to ${target}, rendered a page instead`);
  if (!to.startsWith(target)) {
    return fail(`${path} forwarded to ${to}, expected ${target}`);
  }
  console.log(`  ok  ${path} → ${to} (${res.status})`);
}

async function checkGuarded(path, expected, cookie) {
  const { status, body } = await get(path, cookie);
  if (status >= 500) return fail(`${path} returned ${status}`);
  const crash = crashed(body);
  if (crash) return fail(`${path} rendered the error boundary (${crash})`);
  if (status !== expected) {
    return fail(`${path} answered ${status}, expected ${expected} — this path is meant to refuse`);
  }
  console.log(`  ok  ${path} (${status}, refused)`);
}

/**
 * The operator console, which of two correct answers it gives depending on who
 * is asking.
 *
 * The allow-list is an operator decision — the `PlatformAdmin` table, with
 * `ADMIN_EMAILS` as a bootstrap for a fresh deploy whose table is still empty —
 * and it lives in the running app's environment, not in this process's. So the
 * expectation is not predicted here: a full render and a 404 are both passes,
 * and what fails is a crash, a partial render, or a 404 page that has leaked
 * console content into it.
 *
 * Which one happened is printed loudly, because "the console rendered" is the
 * surprising answer and the one worth a human's eye on a deployed environment.
 */
async function checkAdmin(path, marker, cookie) {
  const { status, body } = await get(path, cookie);
  if (status >= 500) return fail(`${path} returned ${status}`);
  const crash = crashed(body);
  if (crash) return fail(`${path} rendered the error boundary (${crash})`);
  if (status === 404) {
    if (body.includes(marker)) {
      return fail(`${path} 404'd but leaked console content ("${marker}")`);
    }
    return console.log(`  ok  ${path} (404, withheld — this account is not an operator)`);
  }
  if (status !== 200) {
    return fail(`${path} answered ${status} — the console either serves an operator or 404s`);
  }
  if (!body.includes(marker)) {
    return fail(`${path} answered 200 but rendered nothing ("${marker}" missing)`);
  }
  console.log(`  OK  ${path} (200, RENDERED — this account is an operator here)`);
}

async function checkDynamic(spec, cookie) {
  const list = await get(spec.from, cookie);
  const found = spec.pattern.exec(list.body);
  if (!found) {
    return fail(`${spec.route}: ${spec.from} links to no detail page, so it could not be reached`);
  }
  await checkRoute(`${found[1]}${spec.suffix ?? ""}`, spec.marker, cookie);
}

const cookie = await signIn();
console.log("signed in; checking authenticated routes");
for (const [path, marker] of ROUTES) await checkRoute(path, marker, cookie);
console.log("checking detail pages, reached by following a link");
for (const spec of DYNAMIC) await checkDynamic(spec, cookie);
console.log("checking forwarders");
for (const [path, target] of REDIRECTS) await checkRedirect(path, target, cookie);
console.log("checking the operator console");
for (const [path, marker] of ADMIN) await checkAdmin(path, marker, cookie);
for (const [path, expected] of GUARDED) await checkGuarded(path, expected, cookie);
console.log("checking public routes");
for (const [path, marker] of PUBLIC) await checkRoute(path, marker, null);

const total =
  ROUTES.length +
  DYNAMIC.length +
  REDIRECTS.length +
  ADMIN.length +
  GUARDED.length +
  PUBLIC.length;
if (failures) console.error(`\nSMOKE FAILED — ${failures} of ${total} checks failed`);
else console.log(`\nsmoke passed: ${total} checks, every page renders over the wire`);
