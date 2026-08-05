export { normalizeSku } from "./normalize";
export { validatePosSales } from "./validate";
export type { PosValidationError, PosValidationResult } from "./validate";
export { tenantDayKey, dayMarker, parsePosDate } from "./time";
export { resolvePosSkuMap, suggestProductForSku } from "./match";
export type { ProductSuggestion } from "./match";
export {
  planPosIngest,
  aggregateStoredPosLines,
} from "./aggregate";
export type {
  PlannedSale,
  PlannedLine,
  PlannedSalesHistoryRow,
  PosIngestPlan,
  PlanPosIngestInput,
  UnmatchedSku,
  StoredPosLine,
} from "./aggregate";
export { detectSalesGaps } from "./gap";
export type { GapFact, SalesGap } from "./gap";
export {
  authenticatePosFeed,
  generatePosIngestSecret,
  hashPosIngestSecret,
} from "./auth";
export {
  ingestPosSales,
  writeDerivedPosSalesHistory,
} from "./ingest";
export type { PosIngestResult } from "./ingest";
export { fetchPosFeed, parsePosFeed } from "./feed";
export type { FeedFetcher } from "./feed";
export type { PosSaleInput, PosLineInput, MatchProduct } from "./types";
