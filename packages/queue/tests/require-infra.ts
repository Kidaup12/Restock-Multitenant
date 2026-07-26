// The no-overlap enqueue guard is the worker's headline invariant and it is
// only proven against real Redis — never let that suite skip in CI.
import { requireTestInfra } from "../../../scripts/test-infra-guard";

export default function setup(): void {
  requireTestInfra("redis");
}
