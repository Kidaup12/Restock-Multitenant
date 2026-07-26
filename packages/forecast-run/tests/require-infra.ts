// The walk-forward backtest proof only exists against a seeded local database —
// a skipped run in CI would leave it unproven.
import { requireTestInfra } from "../../../scripts/test-infra-guard";

export default function setup(): void {
  requireTestInfra("db");
}
