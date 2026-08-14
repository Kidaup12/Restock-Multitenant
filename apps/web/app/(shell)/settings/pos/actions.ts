"use server";

import { revalidatePath } from "next/cache";
import { Prisma, prismaForTenant, prismaService } from "@wezesha/db";
import { generatePosIngestSecret, hashPosIngestSecret } from "@wezesha/pos";
import { activeMembership, requireSession } from "@/lib/auth";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * Till-feed setup: the ingest slug a bridge posts under, and the secret it posts
 * with. Both were database-only until now — a shop could not connect its till
 * without an engineer running a script, which in this market means the majority
 * of its sales were invisible to the forecast.
 *
 * Only the PUSH direction is configurable here. The worker's pull path
 * (TenantConfig.posFeedUrl) authenticates with a single shared POS_FEED_SECRET
 * across every tenant, so letting a shop set that URL would hand it a credential
 * belonging to all the others. That stays an operator setting.
 *
 * The plaintext secret is returned exactly once, by the action that mints it,
 * and never stored — only its SHA-256. Losing it means rotating, which is the
 * correct trade: a secret we could show twice is a secret we are keeping.
 */

export type PosActionResult =
  | { ok: true; message: string; secret?: string }
  | { ok: false; error: string };

const err = (error: string): PosActionResult => ({ ok: false, error });

async function actorContext() {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return null;
  if (!hasPermission(membership, "manage_settings")) return null;
  return { tenantId: membership.tenantId, tenantSlug: membership.tenant.slug, userId: session.user.id };
}

/** Feed slugs live in the same namespace as workspace slugs, because the
 *  resolver accepts either. Same shape, so one can never shadow the other by
 *  looking different. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

function audit(tenantId: string, action: string, userId: string, meta: Prisma.InputJsonObject) {
  return prismaService.auditEvent.create({
    data: { tenantId, entity: "TenantConfig", entityId: tenantId, action, actorUserId: userId, meta },
  });
}

/**
 * Mint a new ingest secret, replacing any current one.
 *
 * Rotation is the only way to get a secret, including the first time — there is
 * no "show me the existing one", because we do not have it. Any bridge using the
 * previous secret stops working the moment this returns, so the copy says so.
 */
export async function rotatePosIngestSecret(): Promise<PosActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");

  const secret = generatePosIngestSecret();
  const db = prismaForTenant(ctx.tenantId);
  const existing = await db.tenantConfig.findUnique({
    where: { tenantId: ctx.tenantId },
    select: { posIngestSecretHash: true },
  });

  await db.tenantConfig.upsert({
    where: { tenantId: ctx.tenantId },
    create: { tenantId: ctx.tenantId, posIngestSecretHash: hashPosIngestSecret(secret) },
    update: { posIngestSecretHash: hashPosIngestSecret(secret) },
  });
  // The secret itself never reaches the ledger — only that it changed, and
  // whether something was replaced.
  await audit(ctx.tenantId, "pos_secret_rotated", ctx.userId, {
    replaced: Boolean(existing?.posIngestSecretHash),
  });

  revalidatePath("/settings/pos");
  return {
    ok: true,
    secret,
    message: existing?.posIngestSecretHash
      ? "New secret created. The previous one stopped working just now."
      : "Secret created. Your till can start sending sales.",
  };
}

/** Close ingest for this workspace. The endpoint has no fallback credential, so
 *  clearing the hash shuts the door rather than loosening it. */
export async function disablePosIngest(): Promise<PosActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");

  const db = prismaForTenant(ctx.tenantId);
  const existing = await db.tenantConfig.findUnique({
    where: { tenantId: ctx.tenantId },
    select: { posIngestSecretHash: true },
  });
  if (!existing?.posIngestSecretHash) return err("Till sales are already switched off.");

  await db.tenantConfig.update({
    where: { tenantId: ctx.tenantId },
    data: { posIngestSecretHash: null },
  });
  await audit(ctx.tenantId, "pos_ingest_disabled", ctx.userId, {});

  revalidatePath("/settings/pos");
  return { ok: true, message: "Till sales switched off. Nothing can post to this workspace now." };
}

/**
 * Set (or clear) the slug a bridge posts under. Clearing falls back to the
 * workspace's own slug, which is what the resolver does anyway — so "no custom
 * slug" is a real state, not an unconfigured one.
 */
export async function setPosFeedSlug(input: { slug: string }): Promise<PosActionResult> {
  const ctx = await actorContext();
  if (!ctx) return err("You don't have settings access in this workspace.");

  const slug = input.slug.trim().toLowerCase();
  const db = prismaForTenant(ctx.tenantId);

  if (slug.length === 0) {
    await db.tenantConfig.upsert({
      where: { tenantId: ctx.tenantId },
      create: { tenantId: ctx.tenantId, posFeedSlug: null },
      update: { posFeedSlug: null },
    });
    await audit(ctx.tenantId, "pos_feed_slug_changed", ctx.userId, { to: null });
    revalidatePath("/settings/pos");
    return { ok: true, message: `Using your workspace name, ${ctx.tenantSlug}.` };
  }

  if (!SLUG_RE.test(slug)) {
    return err("Use 2–40 characters: lowercase letters, numbers and hyphens, starting with a letter or number.");
  }

  // A feed slug that matches another workspace's own slug would shadow it in the
  // resolver, so their till would resolve to us and stop working. findMany
  // rather than a single-row lookup: resolving one tenant is the sanctioned
  // resolver's job, and this is an existence probe, not a resolution.
  //
  // It has to span tenants — the question is precisely "does a workspace other
  // than mine own this slug?", which a tenant-scoped client cannot answer. The
  // `NOT` is the exclusion of self, not a scope, so the rule is right to report
  // it. Nothing about another workspace leaves this function: the result is
  // narrowed to a single id, read only for its length, and the caller sees one
  // boolean. The unique index below is the actual guard.
  // eslint-disable-next-line tenant-safety/require-tenant-scope -- cross-tenant slug collision check; returns a boolean, never another tenant's data
  const shadowed = await prismaService.tenant.findMany({
    where: { slug, NOT: { id: ctx.tenantId } },
    select: { id: true },
    take: 1,
  });
  if (shadowed.length > 0) return err("That name is already in use. Pick another.");

  try {
    await db.tenantConfig.upsert({
      where: { tenantId: ctx.tenantId },
      create: { tenantId: ctx.tenantId, posFeedSlug: slug },
      update: { posFeedSlug: slug },
    });
  } catch (error) {
    // The unique index is the real guard — a check-then-write would still race
    // two workspaces claiming the same slug at once.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return err("That name is already in use. Pick another.");
    }
    throw error;
  }
  await audit(ctx.tenantId, "pos_feed_slug_changed", ctx.userId, { to: slug });

  revalidatePath("/settings/pos");
  return { ok: true, message: `Your till should now post under ${slug}.` };
}
