import { hasPermission, type PermissionSource } from "@/lib/auth/permissions";

/**
 * Gate for cost/margin figures: renders children only when the viewing
 * membership has `view_costs`, otherwise a masked placeholder (or the given
 * fallback). No hooks, so it works in server and client components alike.
 * The gate hides display only — callers should also skip the underlying
 * lookup when it is closed, and no money value should reach the client for a
 * membership that can't see it.
 */
export function MoneyGate({
  membership,
  fallback,
  children,
}: {
  membership: PermissionSource | null;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (membership && hasPermission(membership, "view_costs")) {
    return <>{children}</>;
  }
  if (fallback !== undefined) return <>{fallback}</>;
  return (
    <span
      role="img"
      aria-label="Hidden — requires cost access"
      title="Hidden — requires cost access"
      className="font-mono tracking-wider text-ink-faint select-none"
    >
      •••••
    </span>
  );
}
