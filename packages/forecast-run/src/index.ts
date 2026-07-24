// Nightly forecast run (cold-start borrow, owner priors, confidence word,
// explainParts persistence).
export { runForecast, type ForecastRunResult } from "./run";

// Monthly walk-forward backtest, champion audit, degradation alert.
export {
  runBacktest,
  accuracyDropBody,
  DEFAULT_HORIZON_DAYS,
  DEGRADATION_THRESHOLD,
  DROP_DEDUP_DAYS,
  type BacktestRunOutcome,
} from "./backtest-run";

// Owner-prior write path ("tell the forecast something").
export {
  createOwnerPrior,
  revokeOwnerPrior,
  listOwnerPriors,
  validateOwnerPriorInput,
  type CreateOwnerPriorInput,
  type OwnerPriorRecord,
  type OwnerPriorScope,
} from "./owner-priors";
