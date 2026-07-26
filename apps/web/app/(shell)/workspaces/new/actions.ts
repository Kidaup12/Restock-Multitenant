"use server";

import { redirect } from "next/navigation";
import { requireSession, setWorkspaceCookie } from "@/lib/auth";
import { createWorkspace } from "@/lib/auth/workspaces";

/** Create the workspace, make it the caller's active one, and land in it. */
export async function createWorkspaceAction(
  name: string,
): Promise<{ error: string }> {
  const session = await requireSession();
  const result = await createWorkspace({ userId: session.user.id, name });
  if (!result.ok) return { error: result.error };
  await setWorkspaceCookie(result.tenantId);
  redirect("/today");
}
