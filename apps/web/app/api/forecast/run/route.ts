import { NextResponse } from "next/server";
import { activeMembership, getSession } from "@/lib/auth";
import { runForecast } from "@/lib/forecast-run/run";

/** Kick a forecast run for the caller's active workspace. Session-guarded;
 *  the tenant comes from the membership, never from the request body. */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const membership = await activeMembership(session.user.id);
  if (!membership) {
    return NextResponse.json({ error: "no workspace" }, { status: 403 });
  }

  try {
    const result = await runForecast(membership.tenantId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("forecast run failed:", err);
    return NextResponse.json({ error: "forecast run failed" }, { status: 500 });
  }
}
