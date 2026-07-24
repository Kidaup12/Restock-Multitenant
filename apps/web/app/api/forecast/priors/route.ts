import { NextResponse } from "next/server";
import { withCapture } from "@/lib/observability/wrap";
import {
  createPriorForActiveTenant,
  listPriorsForActiveTenant,
  revokePriorForActiveTenant,
} from "@/lib/forecast-trust/priors";

/**
 * Owner-prior write path — "tell the forecast something" (spec §6). Session +
 * the manage_settings gate + tenant scope are enforced in the lib. The trust
 * surfaces render this in a later wave; this endpoint is the data path they call.
 */

const num = (v: unknown): number | null | undefined =>
  v == null ? (v as null | undefined) : typeof v === "number" && Number.isFinite(v) ? v : NaN;

/** List priors for the active workspace. `?activeOnly=1` filters to the applied ones. */
export const GET = withCapture(
  async (req: Request) => {
    const activeOnly = new URL(req.url).searchParams.get("activeOnly") === "1";
    const result = await listPriorsForActiveTenant({ activeOnly });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ priors: result.data });
  },
  { route: "/api/forecast/priors", errorMessage: "could not list forecast priors" }
);

/** Create a prior: { scope, scopeValue, expectedUnits?, multiplier?, proxyProductId?, weeks?, note? }. */
export const POST = withCapture(
  async (req: Request) => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });

    const scope = body.scope === "brand" ? "brand" : "product";
    const scopeValue = typeof body.scopeValue === "string" ? body.scopeValue : "";
    const expectedUnits = num(body.expectedUnits);
    const multiplier = num(body.multiplier);
    const weeks = num(body.weeks);
    if (Number.isNaN(expectedUnits) || Number.isNaN(multiplier) || Number.isNaN(weeks)) {
      return NextResponse.json({ error: "expectedUnits, multiplier and weeks must be numbers" }, { status: 400 });
    }

    const result = await createPriorForActiveTenant({
      scope,
      scopeValue,
      expectedUnits: expectedUnits ?? null,
      multiplier: multiplier ?? null,
      proxyProductId: typeof body.proxyProductId === "string" ? body.proxyProductId : null,
      weeks: weeks ?? undefined,
      note: typeof body.note === "string" ? body.note : null,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.data, { status: 201 });
  },
  { route: "/api/forecast/priors", errorMessage: "could not save the forecast prior" }
);

/** Revoke a prior: DELETE /api/forecast/priors?id=<id> (soft-delete; still listed). */
export const DELETE = withCapture(
  async (req: Request) => {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const result = await revokePriorForActiveTenant(id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.data);
  },
  { route: "/api/forecast/priors", errorMessage: "could not revoke the forecast prior" }
);
