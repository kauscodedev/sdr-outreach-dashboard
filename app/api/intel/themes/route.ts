/**
 * Themes — GET /api/intel/themes?from=YYYY-MM-DD&to=YYYY-MM-DD&label=<SignalLabel>&scope=mine|all
 * Aggregated signal themes (mentions/accounts/reps per label+category), the weekly trend for one
 * label, and verbatim examples. Dates are US/Eastern civil days, both inclusive.
 */
import { NextRequest, NextResponse } from "next/server";
import { etDayStartMs, etDateStr } from "../../../../lib/sync/buckets";
import { loadThemes } from "../../../../lib/intel/themes";
import { SIGNAL_LABELS, SignalLabel, ThemesResponse } from "../../../../lib/intel/types";
import { resolveViewer } from "../../../../lib/access/resolve";
import { supabaseServer } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export async function GET(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  const viewer = await resolveViewer(user?.email ?? "");

  const sp = req.nextUrl.searchParams;
  const to = sp.get("to") && DATE_RE.test(sp.get("to")!) ? sp.get("to")! : etDateStr(Date.now());
  const from = sp.get("from") && DATE_RE.test(sp.get("from")!)
    ? sp.get("from")!
    : etDateStr(Date.now() - 29 * DAY_MS); // default: last 30 ET days
  const fromMs = etDayStartMs(from);
  const toMs = etDayStartMs(to, 1);
  if (!(fromMs < toMs)) return NextResponse.json({ error: "from must be <= to" }, { status: 400 });

  const labelParam = sp.get("label") ?? "objection";
  const trendLabel: SignalLabel = (SIGNAL_LABELS as readonly string[]).includes(labelParam)
    ? (labelParam as SignalLabel) : "objection";

  const scopeAll = sp.get("scope") === "all" || viewer.defaultOwnerIds.length === 0;
  const ownerIds = scopeAll ? null : viewer.defaultOwnerIds;

  const data = await loadThemes({ fromMs, toMs, trendLabel, ownerIds });
  const res: ThemesResponse = { from, to, themes: data.themes, trend: data.trend, trendLabel, examples: data.examples };
  return NextResponse.json(res);
}
