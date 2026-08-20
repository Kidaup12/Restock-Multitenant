// The db-backed session-auth suite skips itself without a local service
// connection; in CI that silence is a hole, so fail instead.
import { ensureTestDatabase } from "../../../scripts/test-database-setup";
import { requireTestInfra } from "../../../scripts/test-infra-guard";

// The suites get their own database — seedDev() rebuilds the demo tenant,
// and doing that to the development database wipes the state a tester was
// handed (see scripts/test-database.ts).
export default async function setup(): Promise<void> {
  await ensureTestDatabase();
  requireTestInfra("db");
}
