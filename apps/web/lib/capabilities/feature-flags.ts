/**
 * Capability gate 4 — per-tenant feature switches. A flag stored on
 * TenantConfig.featureFlags turns a surface on or off for the whole tenant; an
 * absent flag falls back to its documented default here. Settings toggles are
 * the only writers — this module is the reader plus the defaults.
 */

export const FEATURE_KEYS = [
  "transfers",
  "pos_feed",
  "quickbooks",
  "supplier_email",
  "weekly_digest",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * Defaults when a tenant hasn't set a switch. Most surfaces default ON so the
 * product is whole out of the box; weekly_digest defaults OFF because it sends
 * email on a schedule — a side-effecting surface a shop opts into, not out of.
 */
export const FEATURE_DEFAULTS: Record<FeatureKey, boolean> = {
  transfers: true,
  pos_feed: true,
  quickbooks: true,
  supplier_email: true,
  weekly_digest: false,
};

/** The TenantConfig field the reader needs — assignable from a Prisma row. */
export type FeatureConfigSource = { featureFlags: unknown };

/** Whether a feature is on for this tenant: the stored boolean when present and
 *  valid, otherwise the documented default. A null config = all defaults. */
export function featureEnabled(
  config: FeatureConfigSource | null,
  key: FeatureKey,
): boolean {
  const flags = config?.featureFlags;
  if (flags && typeof flags === "object" && !Array.isArray(flags)) {
    const value = (flags as Record<string, unknown>)[key];
    if (typeof value === "boolean") return value;
  }
  return FEATURE_DEFAULTS[key];
}

/** The full resolved switch set (defaults merged with any stored overrides). */
export function resolveFeatureFlags(
  config: FeatureConfigSource | null,
): Record<FeatureKey, boolean> {
  const out = {} as Record<FeatureKey, boolean>;
  for (const key of FEATURE_KEYS) out[key] = featureEnabled(config, key);
  return out;
}
