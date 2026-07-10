import { NextRequest, NextResponse } from "next/server";
import { getTrackedOwnerIds } from "../../../../../lib/team/load";
import { getRepCalls } from "../../../../../lib/callquality/fetch";

export const dynamic = "force-dynamic";

/** Recent analyzed calls + BANTIC dim averages for one rep (lazy-loaded by the drawer).
 *  Validated against the DB-backed tracked roster, so AEs added via the control center work. */
export async function GET(_req: NextRequest, { params }: { params: { ownerId: string } }) {
  const tracked = await getTrackedOwnerIds();
  if (!tracked.includes(params.ownerId)) {
    return NextResponse.json({ error: "unknown rep" }, { status: 404 });
  }
  const payload = await getRepCalls(params.ownerId);
  return NextResponse.json(payload);
}
