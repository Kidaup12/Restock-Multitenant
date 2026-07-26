// The db-backed session-auth suite skips itself without a local service
// connection; in CI that silence is a hole, so fail instead.
import { requireTestInfra } from "../../../scripts/test-infra-guard";

export default function setup(): void {
  requireTestInfra("db");
}
