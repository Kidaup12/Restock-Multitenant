# Environment checklist for a hosting move

Companion to `deploy/MIGRATE-HOSTING.md`. `deploy/ENVIRONMENT.md` stays the reference for what
each variable *does*; this is the list to work down during a cutover, grouped by where the value
comes from rather than by service.

Nothing here carries a value. Read the current ones from the existing Vercel and Railway
dashboards as you go — they are secrets and belong in those two places only.

## 1. Carry verbatim, or the system breaks

Two variables where a regenerated value is not "a new setting", it is data loss or an outage.

| variable | where | what happens if it changes |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | Vercel **and** Railway — same value on both | Every stored Shopify token is AES-256-GCM ciphertext under this key. A new key makes all live connections undecryptable, and nothing recovers them. Each merchant would have to reconnect. |
| `BETTER_AUTH_SECRET` | Vercel | Signs sessions and the admin workspace cookie. A new one signs everybody out at once. Recoverable — people log in again — but not a surprise you want mid-onboarding. |

Copy these first, before anything else, and confirm they match on both hosts.

## 2. New values from the new infrastructure

| variable | where | source |
|---|---|---|
| `DATABASE_URL` | Vercel, Railway | New project's **pooled** connection as `wezesha_app`. RLS enforced. |
| `SERVICE_DATABASE_URL` | Vercel, Railway | New project's **pooled** connection as `wezesha_service` (BYPASSRLS). |
| `DIRECT_URL` | **Neither runtime host** — ops machine or CI only | Direct (non-pooled) owner connection, for `migrate deploy` and the RLS test suite. |
| `REDIS_URL` | Vercel; Railway as a reference to its own Redis service | The new Redis. |

Two things that are easy to get wrong here:

- **The pooled settings differ per service on purpose.** The web app runs serverless and uses a
  much smaller `connection_limit` than the worker. Copy the shape of the current values, not just
  the host — `deploy/ENVIRONMENT.md` shows both. The nightly forecast has already died twice on
  connection exhaustion.
- **The region is part of the host** (`aws-0-<region>.pooler.supabase.com`). Moving region changes
  every one of these strings, not just the project reference.

## 3. Decided by whether the public domain changes

| variable | where | note |
|---|---|---|
| `SHOPIFY_APP_URL` | Vercel, Railway | Builds the OAuth redirect URI **and** the webhook callback. If this changes, every merchant who registered their own Shopify app must update their redirect URI, and webhooks re-register. See the runbook. |
| `BETTER_AUTH_URL` | Vercel | The app's own origin, for invite links and canonical URLs. |
| `NEXT_PUBLIC_WS_URL` | Vercel | `wss://` origin of the new ws-gateway. Unset is survivable — the app works, it just stops live-updating. |

## 4. Carry across unchanged

Values that are neither secret-critical nor infrastructure-derived. Copy them as they are.

- `EMAIL_FROM` — the sender address
- `ADMIN_EMAILS` — bootstrap operator list; inert once a `PlatformAdmin` row exists, but leaving
  it empty with no row means the admin console 404s for everyone
- `SENTRY_ENVIRONMENT` — `production`
- `SHOPIFY_SYNC_PATTERN` — only if the current deployment overrides the default

## 5. Re-issue or carry, your call

Nothing breaks if these get new values, so long as they are valid.

- `RESEND_API_KEY` (Vercel + Railway) — **with `NODE_ENV=production` an unset key makes every
  send throw**, so this cannot be left blank on a production host
- `POS_FEED_SECRET` (Railway) — only matters for tenants with a POS feed URL set
- `SENTRY_DSN` (Vercel, Railway worker, Railway ws-gateway) — three services, and the tracker is
  a complete no-op without it. A fresh deployment is the natural moment to set it: the contract's
  error-tracking milestone is not met while it is unset.

## 6. Never set by hand

- `PORT` — Railway injects it
- `NODE_ENV` — set by Vercel/Next and the Dockerfiles
- `NEXT_OUTPUT` — set to `standalone` by the web Dockerfile; leave unset on Vercel

## 7. The cron flags — off during the move, on after

All on the Railway worker, all `1` to enable. Set them **after** the database is verified, not
before: a cron firing mid-cutover writes to whichever database the worker happens to be pointed
at.

`FORECAST_CRON` · `SHOPIFY_SYNC_CRON` · `SNAPSHOT_CRON` · `EMAIL_CRONS` · `OPS_CRONS` ·
`POS_CRONS` · `COST_CRONS`

Leaving one unset is a silent half-migration: with `SHOPIFY_SYNC_CRON` off, a shop's data only
refreshes when somebody presses Sync now, and the buy list ages without saying so. Check all
seven are present and set before calling the move done.

## Order

1. Copy §1 to both hosts and confirm they match.
2. Set §2 once the restore is verified, not before.
3. Settle the domain question, then §3.
4. §4, §5, §6.
5. Verify the app reads and writes against the new database.
6. Only then §7, and watch one sync tick and one forecast run land.
