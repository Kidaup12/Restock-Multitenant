// Server entry: the Prisma clients plus the shared domain constants. Client
// components must not import this root — ./client instantiates PrismaClient and
// throws on a missing SERVICE_DATABASE_URL the moment the module evaluates.
// Browser-safe values live behind subpaths (`@wezesha/db/roles`); types are safe
// from anywhere because `import type` is erased.
export { prismaAuth, prismaForTenant, prismaForTenantTx, prismaService } from "./client";
export type { TenantClient } from "./client";
export {
  DEFAULT_PLAN,
  GRACE_DAYS,
  PLAN_TIERS,
  computeLimitState,
  graceLeft,
  resolvePlanLimits,
} from "./limits";
export type { LimitKey, LimitState, LimitUsage, PlanLimits, PlanSource, UsageCounts } from "./limits";
export {
  LOCATION_ROLE_DESCRIPTIONS,
  LOCATION_TYPE_LABELS,
  LOCATION_TYPES,
  guessRoleFromName,
  isEnroute,
  isHolds,
  isIgnore,
  isSellable,
  roleOf,
  roleOfType,
  typeOfRole,
} from "./roles";
export type { LocationRole, LocationType } from "./roles";
export {
  BUYABLE_PRODUCT_WHERE,
  LIFECYCLE_LABELS,
  NOT_SELLING_STATUSES,
  PRODUCT_STATUSES,
  heldReason,
  isBuyable,
  isProductStatus,
  productLifecycle,
} from "./product-lifecycle";
export type { ProductLifecycle, ProductStatus } from "./product-lifecycle";
export { Prisma, Role } from "../generated/client";
export type { Tenant, Membership, TenantConfig } from "../generated/client";
export type { User, Session, Account, Verification } from "../generated/client";
export type {
  Product,
  Supplier,
  Location,
  InventoryLevel,
  InventorySnapshot,
  WarehouseLocationMap,
  IgnoreRule,
  LocationClosure,
  SavedFilter,
} from "../generated/client";
export type {
  SalesHistory,
  PosSale,
  PosSaleLine,
  MonthlyContext,
  Promo,
  Prediction,
  BacktestRun,
  SpotCheck,
} from "../generated/client";
export type {
  Order,
  PurchaseOrder,
  PurchaseOrderLine,
  DistributionPlan,
  DistributionPlanLine,
  AuditEvent,
} from "../generated/client";
export type {
  ShopifyConnection,
  IngestCursor,
  Notification,
  WebhookEvent,
} from "../generated/client";
