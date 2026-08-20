// Vitest does not load .env on its own (the Prisma CLI does) — pull in the
// package-local .env so tests see the same three URLs as migrations.
import "dotenv/config";

// Same rule as the globalSetup, derived rather than passed: these run in
// separate processes. A no-op in CI and when no database is configured.
import { redirectToTestDatabase } from "../../../scripts/test-database";
redirectToTestDatabase();
