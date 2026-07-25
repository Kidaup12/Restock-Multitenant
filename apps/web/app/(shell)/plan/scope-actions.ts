"use server";

import { prismaForTenant } from "@wezesha/db";
import { activeMembership, requireSession } from "@/lib/auth";
import { LEAD_BANDS, type LeadBand, type ScopeSelection } from "./scope-bar";

/**
 * Saved planner scopes: named presets of the scope-bar's ABC / category /
 * supplier / lead-band selection, persisted per member in the shared
 * SavedFilter table (page = "planner"). Tenant and user resolve from the
 * session server-side — the client never supplies a tenantId — and every
 * read/write runs on the RLS-enforced tenant client, so one workspace never
 * sees another's scopes, and the userId + page filter keeps a member's scopes
 * to their own.
 *
 * Money-blind safe: a scope is pure filter metadata (which classes, categories,
 * suppliers, and lead bands to show), never a cost figure — safe for any role.
 */

const PAGE = "planner";
const MAX_NAME = 60;
/** Sanity cap per member so a scripted caller can't fill the table. */
const MAX_SCOPES = 50;

export type SavedScope = { id: string; name: string; selection: ScopeSelection };

export type ScopeActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const err = <T,>(error: string): ScopeActionResult<T> => ({ ok: false, error });

/** Keep only the string members of an unknown value — a stored query could be
 *  malformed or from an older shape, so nothing is trusted on the way in. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Reconstruct a clean ScopeSelection from a stored query (a JSON string, or a
 *  plain object if the column ever held one). Unknown lead bands are dropped so
 *  the applied selection is always one the scope bar can render. */
function parseSelection(raw: unknown): ScopeSelection {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  const rec = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const leadBand = asStringArray(rec.leadBand).filter((v): v is LeadBand =>
    (LEAD_BANDS as readonly string[]).includes(v)
  );
  return {
    abc: asStringArray(rec.abc),
    category: asStringArray(rec.category),
    supplier: asStringArray(rec.supplier),
    leadBand,
  };
}

/** Save the current scope selection under a name for the caller. Overwrites
 *  nothing — a repeated name is a distinct saved scope, same as browser
 *  bookmarks. */
export async function saveScope(input: {
  name: string;
  selection: ScopeSelection;
}): Promise<ScopeActionResult<SavedScope>> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return err("Give the scope a name.");
  if (name.length > MAX_NAME) return err(`Keep the name under ${MAX_NAME} characters.`);

  const selection = parseSelection(input.selection);

  const db = prismaForTenant(membership.tenantId);
  const existing = await db.savedFilter.count({ where: { userId: session.user.id, page: PAGE } });
  if (existing >= MAX_SCOPES) return err("You've saved as many scopes as we hold. Delete one first.");

  const saved = await db.savedFilter.create({
    data: {
      tenantId: membership.tenantId,
      userId: session.user.id,
      page: PAGE,
      name,
      query: JSON.stringify(selection),
    },
  });
  return { ok: true, data: { id: saved.id, name: saved.name, selection } };
}

/** The caller's own saved planner scopes, oldest first. */
export async function listScopes(): Promise<ScopeActionResult<SavedScope[]>> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");

  const db = prismaForTenant(membership.tenantId);
  const rows = await db.savedFilter.findMany({
    where: { userId: session.user.id, page: PAGE },
    orderBy: { createdAt: "asc" },
  });
  return {
    ok: true,
    data: rows.map((row) => ({ id: row.id, name: row.name, selection: parseSelection(row.query) })),
  };
}

/** Delete one of the caller's saved scopes. Scoped by userId + page as well as
 *  tenant (RLS): a member can only delete their own planner scopes, never
 *  another member's saved views in the same workspace. */
export async function deleteScope(input: {
  id: string;
}): Promise<ScopeActionResult<{ id: string }>> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id);
  if (!membership) return err("You're not in a workspace.");

  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) return err("Pick a scope to delete.");

  const db = prismaForTenant(membership.tenantId);
  const result = await db.savedFilter.deleteMany({
    where: { id, userId: session.user.id, page: PAGE },
  });
  if (result.count === 0) return err("That scope is gone already.");
  return { ok: true, data: { id } };
}
