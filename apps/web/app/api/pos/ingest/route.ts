import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { ingestPosSales, resolvePosFeedTenant, type PosSaleInput } from "@wezesha/pos";
import { withCapture } from "@/lib/observability/wrap";

/**
 * POS feed ingest — accepts a window of physical sales as a POST payload and
 * runs the shared idempotent ingest. This is the payload path that mirrors the
 * worker's feed pull (identical semantics); a real POS provider or an n8n bridge
 * posts here on its own cadence.
 *
 * Auth is a shared bearer secret (POS_INGEST_SECRET), NOT a user session — the
 * caller is a machine feed. The tenant is resolved from the body's `slug`
 * (TenantConfig.posFeedSlug, else the tenant slug), never from a session.
 *
 * Body: { slug: string, sales: PosSaleInput[] }.
 */
export const POST = withCapture(async (request: Request) => {
  const secret = process.env.POS_INGEST_SECRET;
  if (!secret) return NextResponse.json({ error: "pos ingest not configured" }, { status: 503 });

  const header = request.headers.get("authorization") ?? "";
  if (!bearerMatches(header, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { slug?: unknown; sales?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
  if (!Array.isArray(body.sales)) {
    return NextResponse.json({ error: "sales must be an array" }, { status: 400 });
  }

  const tenant = await resolvePosFeedTenant(slug);
  if (!tenant) return NextResponse.json({ error: "unknown slug" }, { status: 404 });

  const result = await ingestPosSales({ tenantId: tenant.id, sales: body.sales as PosSaleInput[] });
  if (!result) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  return NextResponse.json(result);
});

/** Constant-time bearer check (avoids leaking the secret via response timing). */
function bearerMatches(header: string, secret: string): boolean {
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
