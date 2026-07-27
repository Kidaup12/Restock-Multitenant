import { Prisma, prismaForTenantTx, prismaService } from "@wezesha/db";
import { dayMarker } from "@wezesha/pos";
import { isDayKey } from "@/lib/signals/dates";

/**
 * The only writer for LocationClosure rows. Two surfaces record a closed day —
 * the Sales fix queue's "Shop was closed" dismissal (lib/pos/match.ts) and the
 * Settings declare form — and both land here, so the same (location, day) can
 * never be written two ways that disagree. Tenant writes run RLS-scoped; the
 * audit row rides the service client, the same split the POS fixes use.
 */

export type ClosureActor = { userId: string; name: string };

export type ClosureWriteResult =
  | { ok: true; days: number }
  | { ok: false; reason: "no_location" | "bad_day" };

export async function recordClosure(
  tenantId: string,
  input: { locationId: string; dayKeys: string[]; reason?: string; note?: string | null },
  actor: ClosureActor,
  audit: { action: string; meta: Prisma.InputJsonObject }
): Promise<ClosureWriteResult> {
  const { dayKeys } = input;
  if (dayKeys.length === 0 || dayKeys.some((key) => !isDayKey(key))) {
    return { ok: false, reason: "bad_day" };
  }
  const reason = input.reason?.trim() || "closed";
  // undefined = caller has nothing to say about the note; null = clear it.
  const note = input.note === undefined ? undefined : input.note?.trim() || null;

  const outcome = await prismaForTenantTx(
    tenantId,
    async (tx): Promise<ClosureWriteResult> => {
      const location = await tx.location.findFirst({
        where: { id: input.locationId, tenantId },
        select: { id: true },
      });
      if (!location) return { ok: false as const, reason: "no_location" as const };
      for (const dayKey of dayKeys) {
        await tx.locationClosure.upsert({
          where: { locationId_date: { locationId: input.locationId, date: dayMarker(dayKey) } },
          create: {
            tenantId,
            locationId: input.locationId,
            date: dayMarker(dayKey),
            reason,
            note: note ?? null,
            createdByUserId: actor.userId,
          },
          update: note === undefined ? { reason } : { reason, note },
        });
      }
      return { ok: true as const, days: dayKeys.length };
    }
  );

  if (outcome.ok) {
    await prismaService.auditEvent.create({
      data: {
        tenantId,
        entity: "LocationClosure",
        entityId: input.locationId,
        action: audit.action,
        actorUserId: actor.userId,
        actorName: actor.name,
        meta: audit.meta,
      },
    });
  }
  return outcome;
}

/**
 * Undo one declared closed day. LocationClosure carries no soft-delete column,
 * so a mistyped day is a real delete — the audit row is what keeps the history,
 * and the day simply counts as trading again on the next forecast run.
 */
export async function removeClosure(
  tenantId: string,
  input: { locationId: string; dayKey: string },
  actor: ClosureActor
): Promise<{ ok: true } | { ok: false; reason: "bad_day" | "not_found" }> {
  if (!isDayKey(input.dayKey)) return { ok: false, reason: "bad_day" };

  const removed = await prismaForTenantTx(tenantId, (tx) =>
    tx.locationClosure.deleteMany({
      where: { locationId: input.locationId, date: dayMarker(input.dayKey) },
    })
  );
  if (removed.count === 0) return { ok: false, reason: "not_found" };

  await prismaService.auditEvent.create({
    data: {
      tenantId,
      entity: "LocationClosure",
      entityId: input.locationId,
      action: "closure_removed",
      actorUserId: actor.userId,
      actorName: actor.name,
      meta: { dayKey: input.dayKey },
    },
  });
  return { ok: true };
}
