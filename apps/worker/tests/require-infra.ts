// A db/redis suite that skips itself in CI asserts nothing while the job goes
// green. Fail the run instead.
import { requireTestInfra } from "../../../scripts/test-infra-guard";

export default function setup(): void {
  requireTestInfra("db", "redis");
}
