export { prismaForTenant, prismaForTenantTx, prismaService } from "./client";
export type { TenantClient } from "./client";
export { Prisma, Role } from "../generated/client";
export type { Tenant, Membership, TenantConfig } from "../generated/client";
export type {
  Product,
  Supplier,
  Location,
  InventoryLevel,
  InventorySnapshot,
  WarehouseLocationMap,
  IgnoreRule,
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
