import { activeMembership, getSession } from "@/lib/auth";

export type TenantActor = {
  userId: string;
  tenantId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
};

/** Session + active-workspace membership for API routes. Null = respond 401. */
export async function tenantActor(): Promise<TenantActor | null> {
  const session = await getSession();
  if (!session) return null;
  const membership = await activeMembership(session.user.id);
  if (!membership) return null;
  return { userId: session.user.id, tenantId: membership.tenantId, role: membership.role };
}

/** Connecting/disconnecting a store is workspace administration. */
export function canManageConnections(actor: TenantActor): boolean {
  return actor.role === "OWNER" || actor.role === "ADMIN";
}
