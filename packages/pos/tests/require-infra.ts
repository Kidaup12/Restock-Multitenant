// The ingest integration suite needs a real local database; the pure planner
// suites don't. Fail the CI run rather than let the db half go quiet.
import { ensureTestDatabase } from "../../../scripts/test-database-setup";
import { requireTestInfra } from "../../../scripts/test-infra-guard";

// The suites get their own database — seedDev() rebuilds the demo tenant,
// and doing that to the development database wipes the state a tester was
// handed (see scripts/test-database.ts).
export default async function setup(): Promise<void> {
  await ensureTestDatabase();
  requireTestInfra("db");
}
