import { NextResponse } from "next/server";
import { authenticatePosFeed, ingestPosSales, validatePosSales } from "@wezesha/pos";
import { withCapture } from "@/lib/observability/wrap";

/** Enough for a bridge operator to act on without returning a payload-sized
 *  error body when every row is malformed. */
const MAX_REPORTED_ERRORS = 20;

/**
 * POS feed ingest — accepts a window of physical sales as a POST payload and
 * runs the shared idempotent ingest. This is the payload path that mirrors the
 * worker's feed pull (identical semantics); a real POS provider or an n8n bridge
 * posts here on its own cadence.
 *
 * Auth is a per-tenant bearer secret, NOT a user session — the caller is a
 * machine feed. The body names the tenant (`slug` → TenantConfig.posFeedSlug,
 * else the tenant slug) but naming it grants nothing: the secret is verified
 * against that tenant's own stored hash, so a bridge for one shop cannot write
 * another shop's sales. A tenant with no secret provisioned is closed — there is
 * no shared fallback credential. Provision one with
 * `npx tsx scripts/provision-ingest-secret.ts <slug>` in packages/pos.
 *
 * Every rejection answers the same 401, so the caller learns nothing about which
 * slugs exist.
 *
 * Body: { slug: string, sales: PosSaleInput[] }.
 */
export const POST = withCapture(async (request: Request) => {
  const presented = bearerToken(request.headers.get("authorization"));
  if (!presented) return unauthorized();

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

  const tenant = await authenticatePosFeed(slug, presented);
  if (!tenant) return unauthorized();

  // Validate before anything is written. An unreadable date or a missing lines
  // array used to surface as a 500, which a POS bridge can only respond to by
  // retrying the same bad payload forever — with the shop's till sales missing
  // from restock planning the whole time.
  const parsed = validatePosSales(body.sales);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid sales", errors: parsed.errors.slice(0, MAX_REPORTED_ERRORS) },
      { status: 400 }
    );
  }

  const result = await ingestPosSales({ tenantId: tenant.id, sales: parsed.sales });
  if (!result) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  return NextResponse.json(result);
});

/** One answer for every rejection: no slug, no secret, wrong secret alike. */
function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** The token out of `Authorization: Bearer <token>` ("" when absent or another
 *  scheme). The scheme isn't secret; the token is compared in constant time
 *  downstream, as a digest. */
function bearerToken(header: string | null): string {
  const [scheme, ...rest] = (header ?? "").trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return "";
  return rest.join(" ").trim();
}
