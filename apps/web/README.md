# web

The Wezesha Restock web app: Next.js (App Router), installable PWA.

The shell's primary destinations come from `components/shell/nav-config.tsx` (one
list, so the sidebar, the mobile tab bar and the `/more` overflow can't disagree):
Today, Plan, Orders, Stock, Costs, Suppliers, Sales data, Insights, Settings. Off
the nav: `/profile`, `/workspaces/new` (create a workspace), the Settings
sub-pages (connections, team, locations), and `/admin`, which 404s unless the
account holds a live `PlatformAdmin` row. API routes live under `app/api`.

## Development

From the repo root (npm workspaces):

```
npm install
npm run -w web dev     # http://localhost:3000
npm run -w web build   # production build
npm run -w web lint
```

## Offline behaviour

`public/sw.js` registers in production builds only (`components/sw-register.tsx`).
HTML is never cached — pages can carry authenticated content — so offline
navigations fall back to the neutral `public/offline.html` shell; hashed build
assets are cache-first, other static assets stale-while-revalidate.

## Deployment

Deploys to Vercel with root directory `apps/web`; install/build commands come
from `vercel.json`. Environments and variables: `deploy/ENVIRONMENT.md` at the
repo root; first-deploy steps: `deploy/RUNBOOK.md`.

The build itself fails without `SERVICE_DATABASE_URL`, `DATABASE_URL`,
`BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` — the app imports `@wezesha/db` and
initializes Better Auth while collecting page data. `.env.example` lists the full
local set.
