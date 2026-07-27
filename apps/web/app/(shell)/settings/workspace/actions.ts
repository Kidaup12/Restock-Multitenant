"use server";

import { revalidatePath } from "next/cache";
import { prismaForTenant, prismaService } from "@wezesha/db";
import { parseOrderMethod, type OrderMethod } from "@wezesha/forecast";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * Workspace settings — the first user-facing writer for TenantConfig. Only
 * MANAGE_SETTINGS members may save; the check runs here, not just in the UI,
 * because a disabled input is decoration and a server action is a public
 * endpoint.
 *
 * The action takes no tenant id: it writes to the caller's own membership
 * tenant. That matters for Tenant, which (unlike TenantConfig) carries no RLS
 * policy — the id scope IS the isolation, so it must never come from input.
 *
 * A tenant with no TenantConfig row is "all defaults"; the first save creates
 * the row. Every reader already treats a missing row as defaults, so nothing
 * depends on the row existing.
 */

export type WorkspaceField =
  | "name"
  | "timezone"
  | "alertEmail"
  | "deadStockWindowDays"
  | "methods";

export type WorkspaceSettingsInput = {
  name: string;
  timezone: string;
  /** Empty = clear it; alerts fall back to the earliest owner's login email. */
  alertEmail: string;
  /** Empty = clear it; the dead-stock window falls back to the code default. */
  deadStockWindowDays: string;
  methodA: string;
  methodB: string;
  methodC: string;
};

export type WorkspaceActionResult =
  | { ok: true }
  | { ok: false; error: string; field?: WorkspaceField };

const err = (error: string, field?: WorkspaceField): WorkspaceActionResult => ({
  ok: false,
  error,
  field,
});

const NAME_MAX = 80;
/** A week is the shortest window that isn't noise; two years the longest that
 *  still says anything about a shop's stock. */
const DEAD_STOCK_MIN_DAYS = 7;
const DEAD_STOCK_MAX_DAYS = 730;

/** IANA zone check via the platform's own tz database — the same source the
 *  day-key helpers format with, so anything accepted here will resolve there. */
function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export async function saveWorkspaceSettings(
  input: WorkspaceSettingsInput,
): Promise<WorkspaceActionResult> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");
  if (!hasPermission(membership, "manage_settings")) {
    return err("You don't have settings access.");
  }

  const name = input.name.trim();
  if (!name) return err("Give the workspace a name.", "name");
  if (name.length > NAME_MAX) {
    return err(`Keep the name under ${NAME_MAX} characters.`, "name");
  }

  const timezone = input.timezone.trim();
  if (!isValidTimezone(timezone)) {
    return err("Pick a time zone from the list.", "timezone");
  }

  const rawEmail = input.alertEmail.trim();
  if (rawEmail && !/^\S+@\S+\.\S+$/.test(rawEmail)) {
    return err("Enter a valid email address.", "alertEmail");
  }
  const alertEmail = rawEmail || null;

  const rawWindow = input.deadStockWindowDays.trim();
  let deadStockWindowDays: number | null = null;
  if (rawWindow) {
    const days = Number(rawWindow);
    if (!Number.isInteger(days) || days < DEAD_STOCK_MIN_DAYS || days > DEAD_STOCK_MAX_DAYS) {
      return err(
        `Use a whole number of days between ${DEAD_STOCK_MIN_DAYS} and ${DEAD_STOCK_MAX_DAYS}.`,
        "deadStockWindowDays",
      );
    }
    deadStockWindowDays = days;
  }

  const methods: Record<"A" | "B" | "C", OrderMethod | null> = {
    A: parseOrderMethod(input.methodA),
    B: parseOrderMethod(input.methodB),
    C: parseOrderMethod(input.methodC),
  };
  if (!methods.A || !methods.B || !methods.C) {
    return err("Pick a buying style for each group.", "methods");
  }

  const db = prismaForTenant(membership.tenantId);
  const before = await db.tenant.findUnique({
    where: { id: membership.tenantId },
    select: {
      name: true,
      timezone: true,
      tenantConfig: {
        select: {
          alertEmail: true,
          deadStockWindowDays: true,
          methodA: true,
          methodB: true,
          methodC: true,
        },
      },
    },
  });
  if (!before) return err("That workspace no longer exists.");

  await db.tenant.update({
    where: { id: membership.tenantId },
    data: { name, timezone },
  });

  const config = {
    alertEmail,
    deadStockWindowDays,
    methodA: methods.A,
    methodB: methods.B,
    methodC: methods.C,
  };
  await db.tenantConfig.upsert({
    where: { tenantId: membership.tenantId },
    create: { tenantId: membership.tenantId, ...config },
    update: config,
  });

  type Scalar = string | number | null;
  const changed: Record<string, { from: Scalar; to: Scalar }> = {};
  const track = (key: string, from: Scalar, to: Scalar) => {
    if (from !== to) changed[key] = { from, to };
  };
  track("name", before.name, name);
  track("timezone", before.timezone, timezone);
  track("alertEmail", before.tenantConfig?.alertEmail ?? null, alertEmail);
  track(
    "deadStockWindowDays",
    before.tenantConfig?.deadStockWindowDays ?? null,
    deadStockWindowDays,
  );
  track("methodA", before.tenantConfig?.methodA ?? null, methods.A);
  track("methodB", before.tenantConfig?.methodB ?? null, methods.B);
  track("methodC", before.tenantConfig?.methodC ?? null, methods.C);

  if (Object.keys(changed).length > 0) {
    await prismaService.auditEvent.create({
      data: {
        tenantId: membership.tenantId,
        entity: "Tenant",
        entityId: membership.tenantId,
        action: "settings_updated",
        actorUserId: session.user.id,
        actorName: membership.displayName ?? session.user.name ?? session.user.email,
        meta: { changed },
      },
    });
  }

  // The name rides in the shell header and the dead-stock window drives Today.
  revalidatePath("/settings/workspace");
  revalidatePath("/today");
  return { ok: true };
}
