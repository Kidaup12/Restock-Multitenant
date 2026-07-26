// The redis → gateway → client e2e suite skips itself when Redis is unreachable.
// In CI that must be a failure, not a silent pass.
import { requireTestInfra } from "../../../scripts/test-infra-guard";

export default function setup(): void {
  requireTestInfra("redis");
}
