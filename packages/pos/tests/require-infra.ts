// The ingest integration suite needs a real local database; the pure planner
// suites don't. Fail the CI run rather than let the db half go quiet.
import { requireTestInfra } from "../../../scripts/test-infra-guard";

export default function setup(): void {
  requireTestInfra("db");
}
