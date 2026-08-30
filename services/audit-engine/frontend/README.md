# Inventory Audit Engine — Frontend

Next.js (App Router, TypeScript, Tailwind CSS) frontend for the retail
inventory audit engine. Upload a sales CSV (plus optional stock CSV), run an
audit, and view the results: lost-sales range, stockout episodes, dead stock,
overstock, plus the full HTML report, Excel workbook and data health report.

## Local development

Requires Node 20+ and the audit engine API running (default
`http://localhost:8000`).

```bash
cd frontend
npm install
cp .env.local.example .env.local   # adjust NEXT_PUBLIC_API_URL if needed
npm run dev
```

Open http://localhost:3000.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | Base URL of the audit engine API (no trailing slash) | `http://localhost:8000` |

All API access goes through `lib/api.ts`.

## Production build

```bash
npm run build
npm start
```

## Deploying to Vercel

1. Push the repository to GitHub.
2. In Vercel: **Add New… → Project**, import the GitHub repo.
3. Under **Root Directory**, click **Edit** and set it to `frontend`.
   Vercel auto-detects Next.js; leave build settings as default.
4. Under **Environment Variables**, add
   `NEXT_PUBLIC_API_URL` = your Railway API URL
   (e.g. `https://your-api.up.railway.app`) — no trailing slash.
5. Deploy. Because `NEXT_PUBLIC_*` variables are inlined at build time,
   redeploy after changing the API URL.

The backend must allow CORS from the Vercel domain.
