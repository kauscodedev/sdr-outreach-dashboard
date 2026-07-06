/** Pure mappers/aggregators for call-scoring rows. No I/O — unit-tested. */
import {
  BANTIC_DIMS, BanticDim, CallDims, CallDrillRow, CallRow, CoachingRow,
  CoachingSnapshot, InsightRow,
} from "./types";

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Latest weekly rep-scope snapshot per owner (input order-independent). */
export function pickLatestSnapshots(rows: CoachingRow[]): Record<string, CoachingSnapshot> {
  const out: Record<string, CoachingSnapshot> = {};
  for (const r of rows) {
    if (!r.hubspot_owner_id || r.period_type !== "weekly" || r.scope !== "rep") continue;
    const prev = out[r.hubspot_owner_id];
    if (prev && prev.periodEnd >= r.period_end) continue;
    out[r.hubspot_owner_id] = {
      ownerId: r.hubspot_owner_id,
      periodEnd: r.period_end,
      callsAnalyzed: r.calls_analyzed ?? 0,
      meetingsBooked: r.meetings_booked ?? 0,
      avgBantic: r.avg_bantic_score,
      avgQuality: r.avg_quality_score,
      weakestDimension: r.weakest_dimension,
      strengths: arr(r.top_strengths),
      risks: arr(r.top_risks),
      priorities: arr(r.coaching_priorities),
      drills: arr(r.suggested_drills),
      managerSummary: r.manager_summary,
    };
  }
  return out;
}

const SCORE_KEY: Record<BanticDim, keyof CallRow> = {
  budget: "score_budget", authority: "score_authority", need: "score_need",
  timeline: "score_timeline", impact: "score_impact", current_process: "score_current_process",
};

/** Per-dim averages over analyzed calls; nulls are skipped per-dim (not zeroed). */
export function aggregateDims(calls: CallRow[]): CallDims {
  const dims = {} as Record<BanticDim, number | null>;
  for (const d of BANTIC_DIMS) {
    const vals = calls.map((c) => c[SCORE_KEY[d]] as number | null).filter((v): v is number => v != null);
    dims[d] = vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  const overalls = calls.map((c) => c.overall_score).filter((v): v is number => v != null);
  return {
    count: calls.length,
    overall: overalls.length ? round1(overalls.reduce((a, b) => a + b, 0) / overalls.length) : null,
    dims,
  };
}

function dimsOf(c: CallRow): Record<BanticDim, number | null> {
  const d = {} as Record<BanticDim, number | null>;
  for (const k of BANTIC_DIMS) d[k] = c[SCORE_KEY[k]] as number | null;
  return d;
}

/** Join calls with their quality insight (by call id); missing insight → empty fields. */
export function joinCallInsights(calls: CallRow[], insights: InsightRow[]): CallDrillRow[] {
  const byId = new Map(insights.map((i) => [i.hubspot_call_id, i]));
  return calls.map((c) => {
    const i = byId.get(c.hubspot_call_id);
    return {
      callId: c.hubspot_call_id,
      date: c.call_date,
      companyId: c.hubspot_company_id,
      disposition: c.call_disposition_label,
      durationMs: c.call_duration_ms,
      recordingUrl: c.recording_url,
      overall: c.overall_score,
      dims: dimsOf(c),
      quality: i?.quality_score ?? null,
      coachableMoments: arr(i?.coachable_moments),
      quotes: arr(i?.quote_examples),
      nextAction: i?.recommended_next_action ?? null,
    };
  });
}
