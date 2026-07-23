# web

The Wezesha Restock web app: Next.js (App Router), installable PWA. The
operator-facing shell — Today, Stock, Plan, Orders, Sales, Insights, Settings —
plus API routes as they land.

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
