# Wezesha Restock OS

Multi-tenant stock-replenishment platform for Shopify retailers: demand
forecasting, reorder recommendations, and the purchase-order workflow, with
per-tenant data isolation enforced at the database.

## Layout

- `apps/web` — the Next.js application (frontend + API routes)
- `apps/forecast` — Python forecasting sidecar (planned)

## Development

- Node 24+, npm workspaces: `npm install` from the root.
- Each app documents its own setup in its README.
- Branching: feature/fix branches merge into `develop` for testing;
  `develop` promotes to `main`.
