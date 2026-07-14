/**
 * Calling drill-down for one rep — GET /api/rep/[ownerId]/calling?period=<PeriodKey>
 * or ?from=YYYY-MM-DD&to=YYYY-MM-DD (US/Eastern civil days, both inclusive).
 *
 * Reads call activities from the spine at request time (never the snapshot — contact-level
 * detail for all six periods would blow the one-row snapshot's size budget) and folds them
 * through the pure builder in lib/sync/calling.ts. Auth: the global middleware gates /api/*
 * (session + @spyne.ai); the owner id is validated against the DB-backed tracked roster.
 */
import { NextRequest, NextResponse } from "next/server";
import { PERIOD_KEYS, PeriodKey } from "../../../../../lib/sync/types";
import { makeEtContext, periodBounds, etDayStartMs } from "../../../../../lib/sync/buckets";
import { buildCallingDetail } from "../../../../../lib/sync/calling";
import { loadActivitiesBetween, loadContactMetaFor, loadCompanyNamesFor } from "../../../../../lib/spine/store";
import { getTrackedOwnerIds } from "../../../../../lib/team/load";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 190; // matches /api/metrics/range — the anchor pull is the real data floor

export async function GET(req: NextRequest, { params }: { params: { ownerId: string } }) {
  const tracked = await getTrackedOwnerIds();
  if (!tracked.includes(params.ownerId)) {
    return NextResponse.json({ error: "unknown rep" }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;
  const period = sp.get("period");
  const from = sp.get("from");
  const to = sp.get("to");

  let fromMs: number, toMs: number;
  if (period) {
    if (!(PERIOD_KEYS as readonly string[]).includes(period)) {
      return NextResponse.json({ error: `period must be one of ${PERIOD_KEYS.join(", ")}` }, { status: 400 });
    }
    ({ fromMs, toMs } = periodBounds(period as PeriodKey, makeEtContext(Date.now())));
  } else if (from && to) {
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      return NextResponse.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 });
    }
    fromMs = etDayStartMs(from);
    toMs = etDayStartMs(to, 1); // `to` is inclusive → exclusive bound is the next ET midnight
    if (!(fromMs < toMs)) return NextResponse.json({ error: "from must be <= to" }, { status: 400 });
    if (Math.round((toMs - fromMs) / DAY_MS) > MAX_RANGE_DAYS) {
      return NextResponse.json({ error: `range too large (max ${MAX_RANGE_DAYS} days)` }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: "pass ?period= or ?from=&to=" }, { status: 400 });
  }

  const activities = await loadActivitiesBetween(fromMs, toMs, [params.ownerId]);
  const calls = activities.filter((a) => a.type === "call");

  const contactIds = [...new Set(calls.flatMap((a) => a.contactIds))];
  const companyIds = [...new Set(calls.flatMap((a) => a.companyIds))];
  const [contactMeta, companyNames] = await Promise.all([
    loadContactMetaFor(contactIds),
    loadCompanyNamesFor(companyIds),
  ]);

  const detail = buildCallingDetail(calls, contactMeta, companyNames);
  return NextResponse.json({ owner_id: params.ownerId, period: period ?? null, from: from ?? null, to: to ?? null, ...detail });
}
