// One-command local setup — cross-OS (Windows / macOS / Linux).
// Run from the repo root:  npm run setup
//
// Brings a fresh clone to a working app: installs deps, starts Postgres + Redis
// in Docker, seeds the local env files, applies migrations (which also create the
// restricted DB roles + RLS), generates the Prisma client, and loads demo data.
// Idempotent — safe to re-run.
import { execSync } from "node:child_process";
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });
const step = (n, msg) => console.log(`\n[setup ${n}/7] ${msg}`);

// Prefer Docker Compose v2 ("docker compose"); fall back to legacy "docker-compose".
function composeCmd() {
  try {
    execSync("docker compose version", { stdio: "ignore" });
    return "docker compose";
  } catch {
    return "docker-compose";
  }
}

// Copy an example env file into place only if the target doesn't exist yet.
function seedEnv(example, target) {
  const ex = path.join(root, example);
  const tg = path.join(root, target);
  if (!existsSync(ex)) return;
  if (existsSync(tg)) {
    console.log(`  kept existing ${target}`);
  } else {
    copyFileSync(ex, tg);
    console.log(`  created ${target} from ${example} — fill in any secrets before deploying`);
  }
}

// Wait until Postgres actually ACCEPTS QUERIES — not just until the port opens.
// A fresh container publishes its port the instant it starts, but Postgres needs
// a few more seconds to finish initdb; pg_isready inside the container is the
// real readiness signal (works the same on every OS, incl. WSL).
async function waitForPostgres(compose, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      execSync(`${compose} exec -T db pg_isready -U postgres -q`, { cwd: root, stdio: "ignore" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("Postgres did not become ready within 120s (is Docker healthy?)");
}

async function main() {
  const compose = composeCmd();

  step(1, "installing dependencies");
  run("npm install");

  step(2, "starting Postgres + Redis (Docker)");
  run(`${compose} up -d db redis`);

  step(3, "seeding local env files");
  seedEnv("packages/db/.env.example", "packages/db/.env");
  seedEnv("apps/web/.env.example", "apps/web/.env.local");

  step(4, "waiting for Postgres to accept connections");
  await waitForPostgres(compose);

  step(5, "applying migrations (schema + restricted roles + RLS)");
  run("npm run -w @wezesha/db db:migrate:deploy");

  step(6, "generating the Prisma client");
  run("npm run -w @wezesha/db db:generate");

  step(7, "seeding demo data (tenant amara-beauty, ~30 SKUs, 90 days of sales)");
  run("npx tsx scripts/seed-dev.ts", path.join(root, "packages/db"));

  console.log(`
Setup complete.

  Start the app:      npm run -w web dev
  Start the worker:   npm run -w @wezesha/worker dev   (crons + sync; needs Redis)
  Sign in:            owner@wezesha.test  /  Owner12345!   (also admin@ / staff@ — see docs/QA-TESTPLAN.md)

Docs: docs/QUICKSTART.md  ·  docs/ARCHITECTURE.md
`);
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  console.error("Is Docker running? See docs/QUICKSTART.md for the manual steps.");
  process.exit(1);
});
