# Security incident response

What to do when merchant data may have been exposed, altered, or lost.

Short on purpose. A procedure nobody can follow under pressure is not a procedure, and this one
exists to be used at an inconvenient hour by whoever happens to be on.

Shopify's data-protection review asks whether we have this. More to the point, the app holds several
shops' trading data behind one database, and the failure that matters most — one shop seeing
another's costs and suppliers — is silent unless someone looks.

---

## What counts as an incident

Any of these, suspected or confirmed. Suspected is enough to start.

- **Cross-tenant exposure** — a workspace sees data belonging to another. The most serious class:
  it ends the product's credibility, not just one customer's trust.
- **Credential exposure** — a Shopify access token, the token encryption key, a database URL, or
  `BETTER_AUTH_SECRET` leaking into logs, a repository, a screenshot or a support message.
- **Unauthorised access** — an account or operator session used by someone it does not belong to.
- **Data loss or corruption** — data deleted or altered by accident, a bad migration, or a restore
  that lands the wrong state.
- **Money-blind failure** — a member without cost access seeing costs or margins, directly or
  through a derived figure such as a ranking, a percentage or a filter that partitions on price.

A merchant reporting "I can see numbers that aren't mine" is an incident from the moment it is said,
not from the moment it is confirmed.

---

## The first hour

**1. Write it down before you fix it.** Open a note: what was seen, by whom, when, and how you
found out. An incident reconstructed from memory a week later is worth much less, and the audit
trail alone will not tell you what a person saw on screen.

**2. Stop the bleeding.** In rough order of preference:

- Revoke, don't patch, when a credential is involved — rotate `TOKEN_ENCRYPTION_KEY`,
  `BETTER_AUTH_SECRET`, or the affected Shopify token. Rotating is reversible; a leaked key is not.
- Take the affected surface offline before shipping a hurried fix to it. A wrong fix under pressure
  is how a one-workspace problem becomes an everyone problem.
- For cross-tenant exposure, disable the affected route rather than the whole app if you can be
  precise about which one.

**3. Preserve the evidence.** Do not delete rows, prune logs, or reset the database to "clean up".
Capture the `AuditEvent` rows for the window, the deployment logs, and the commit that was live.
Deleting the trace is worse than the incident.

**4. Work out the blast radius.** Which workspaces, which data, how long, and whether anyone
outside actually saw it. Read-only queries against production; nothing that writes.

---

## Then

**Fix it properly.** A test that fails on the unfixed code before it passes on the fixed code —
otherwise you have not proven the cause, only changed the symptom. Cross-tenant bugs get a test that
exercises real row-level security with two workspaces, not application-level query discipline.

**Tell the people affected.** If personal data was exposed, the merchant is told without undue
delay: what happened, what data, what we have done, what they should do. Plain language, no hedging.
If we are the processor and they are the controller, they may have their own regulator to notify and
a clock to meet — do not delay their decision by softening ours.

**Write it up within a week.** Timeline, cause, blast radius, fix, and what stops a recurrence.
Blameless: the useful question is what made the mistake easy to make and hard to notice.

---

## Standing defences worth knowing

So you know what should have caught it, and what to check first:

| Defence | Where |
|---|---|
| Row-level security on every tenant table, enforced by the database | `packages/db` migrations |
| Application connects as a restricted role that cannot bypass RLS | database role bootstrap |
| Shopify tokens encrypted at rest, AES-256-GCM | `packages/shopify/src/crypto.ts` |
| Operator access limited to an allow-list, fails closed when unset | `apps/web/lib/admin/gate.ts` |
| Operator workspace access expires after 30 minutes and is audited both ways | `apps/web/lib/admin/impersonation.ts` |
| Lint rule refusing unscoped queries on the bypass client | tenant-safety ESLint rule |
| Cost redaction at the data layer, not the component | getters taking `canViewCosts` |

The two that have actually caught real problems are the tenant-safety lint rule and the
money-blind tests. The one that has repeatedly failed to catch things is a passing test suite:
several genuine defects here were invisible to hundreds of green tests and were found only by
opening the screen.

---

## Contacts

Fill in before this is needed, not during:

- **Who decides to notify merchants:** _PLACEHOLDER_
- **Who can rotate production credentials:** _PLACEHOLDER_
- **Merchant-facing contact address:** see `apps/web/lib/legal.ts`
