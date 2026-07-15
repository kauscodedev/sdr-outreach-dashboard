/**
 * AE Deal Radar — GET /api/intel/radar?scope=mine|all. Active deals in the viewer's scope
 * (matched on EITHER the AE deal owner or the SDR owner, so both kinds get a useful lens),
 * ranked by recent risk signals + stage staleness + Deal Health. Pure assembly in
 * lib/intel/radar.ts; capped response.
 */
import { NextRequest, NextResponse } from "next/server";
import { loadDealsWithEvents } from "../../../../lib/spine/store";
import { supabaseAdmin } from "../../../../lib/supabase/admin";
import { buildRadar, RadarCompanyMeta } from "../../../../lib/intel/radar";
import { RadarResponse, RadarSignal, SignalLabel } from "../../../../lib/intel/types";
import { resolveViewer } from "../../../../lib/access/resolve";
import { supabaseServer } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

const RISK_LABELS: SignalLabel[] = ["objection", "risk_phrase", "competitor_mention"];
const SIGNAL_WINDOW_MS = 21 * 86_400_000;
const MAX_DEALS = 200;
const PAGE = 1000;

export async function GET(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  const viewer = await resolveViewer(user?.email ?? "");

  const scopeAll = req.nextUrl.searchParams.get("scope") === "all" || viewer.defaultOwnerIds.length === 0;
  const owners = scopeAll ? null : new Set(viewer.defaultOwnerIds);

  const deals = (await loadDealsWithEvents()).filter((d) =>
    !owners || (d.dealOwnerId != null && owners.has(d.dealOwnerId)) || (d.sdrOwnerId != null && owners.has(d.sdrOwnerId)));

  const db = supabaseAdmin();
  const companyMeta = new Map<string, RadarCompanyMeta>();
  const signalsByAccount = new Map<string, RadarSignal[]>();
  if (db) {
    const companyIds = [...new Set(deals.map((d) => d.companyId).filter(Boolean))] as string[];
    for (let i = 0; i < companyIds.length; i += PAGE) {
      const { data } = await db.from("sdr_companies").select("hs_id,name,last_activity_ms").in("hs_id", companyIds.slice(i, i + PAGE));
      for (const c of data ?? []) {
        companyMeta.set(String(c.hs_id), {
          name: c.name ?? null,
          lastActivityMs: c.last_activity_ms == null ? null : Number(c.last_activity_ms),
        });
      }
    }
    // Recent risk-flavored signals across the window; joined to deal companies in memory.
    const { data: sigs } = await db.from("sdr_intel_signals")
      .select("account_id,label,category,quote,ts_ms")
      .in("label", RISK_LABELS)
      .gte("ts_ms", Date.now() - SIGNAL_WINDOW_MS)
      .order("ts_ms", { ascending: false }).limit(1000);
    for (const s of (sigs ?? []) as { account_id: string | null; label: SignalLabel; category: string | null; quote: string; ts_ms: number | null }[]) {
      if (!s.account_id || !companyMeta.has(s.account_id)) continue;
      const list = signalsByAccount.get(s.account_id) ?? [];
      list.push({ label: s.label, category: s.category, quote: s.quote, tsMs: s.ts_ms == null ? null : Number(s.ts_ms) });
      signalsByAccount.set(s.account_id, list);
    }
  }

  const all = buildRadar({ deals, companyMeta, signalsByAccount, nowMs: Date.now() });
  const res: RadarResponse = { deals: all.slice(0, MAX_DEALS) };
  return NextResponse.json(res);
}
