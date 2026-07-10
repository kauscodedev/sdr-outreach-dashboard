import { NextRequest, NextResponse } from "next/server";
import { getSnapshot } from "../../../../../lib/snapshot";

export const dynamic = "force-dynamic";

/** One rep's GD/Single units with rooftop drill-down (lazy-loaded by the drawer).
 *  Validated against the snapshot (DB-backed roster), so AEs added via the control center work. */
export async function GET(_req: NextRequest, { params }: { params: { ownerId: string } }) {
  const snapshot = await getSnapshot();
  const rep = snapshot.reps[params.ownerId];
  if (!rep) {
    return NextResponse.json({ error: "unknown rep" }, { status: 404 });
  }
  return NextResponse.json({ units: rep.book.units ?? [] });
}
