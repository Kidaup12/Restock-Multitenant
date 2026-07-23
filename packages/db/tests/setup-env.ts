// Vitest does not load .env on its own (the Prisma CLI does) — pull in the
// package-local .env so tests see the same three URLs as migrations.
import "dotenv/config";
