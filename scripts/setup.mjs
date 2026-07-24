// One-command local setup — cross-OS (Windows / macOS / Linux).
// Run from the repo root:  npm run setup
//
// Brings a fresh clone to a working app: installs deps, starts Postgres + Redis
// in Docker, seeds the local env files, applies migrations (which also create the
// restricted DB roles + RLS), generates the Prisma client, and loads demo data.
// Idempotent — safe to re-run.
import { execSync } from "node:child_process";
import { existsSync, copyFileSync } from "node:fs";
import net from "node:net";
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

// Wait until Postgres accepts TCP connections on :5434 (compose maps it there).
function waitForPostgres(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(5434, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error("Postgres not reachable on :5434 after 60s"));
        else setTimeout(tryOnce, 1000);
      });
    };
    tryOnce();
  });
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

  step(4, "waiting for Postgres");
  await waitForPostgres();

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
  Sign in:            dev@wezesha.test  /  Dev12345!

Docs: docs/QUICKSTART.md  ·  docs/ARCHITECTURE.md
`);
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  console.error("Is Docker running? See docs/QUICKSTART.md for the manual steps.");
  process.exit(1);
});
