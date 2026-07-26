// The RLS isolation gates only mean something against a real local database.
import { requireTestInfra } from "../../../scripts/test-infra-guard";

export default function setup(): void {
  requireTestInfra("db");
}
