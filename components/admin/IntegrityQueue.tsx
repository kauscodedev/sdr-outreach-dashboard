"use client";

/**
 * Data-integrity triage queue (blueprint §7.5, read-only v1) — rendered on /admin.
 * Findings from /api/integrity: active orphan deals, slipped demos, stale actives,
 * owner mismatches, ledger stage regressions — each with a deterministic suggested
 * action and HubSpot backlinks. Matches the admin page's slate styling.
 */
import { useEffect, useState } from "react";
import { dealUrl, companyUrl } from "../../config/hubspot";
import { IntegrityKind } from "../../lib/integrity/checks";

interface Item {
  kind: IntegrityKind;
  severity: "high" | "medium";
  deal_id: string;
  company_id: string | null;
  company_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  detail: string;
  suggestion: string;
}
interface Payload { total: number; counts: Partial<Record<IntegrityKind, number>>; items: Item[]; list_cap: number }

const KIND_LABEL: Record<IntegrityKind, string> = {
  orphan_deal: "Orphan deals",
  slipped_demo: "Slipped demos",
  stale_active: "Stale actives",
  owner_mismatch: "Owner mismatches",
  stage_regression: "Stage regressions",
};
const KINDS = Object.keys(KIND_LABEL) as IntegrityKind[];

export default function IntegrityQueue() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<IntegrityKind | "all">("all");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/integrity")
      .then(async (r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, []);

  if (error) return <p className="text-sm text-amber-700">⚠ Integrity checks unavailable: {error}</p>;
  if (!data) return <p className="text-sm text-slate-500">Running integrity checks…</p>;

  const shown = data.items.filter((i) => kind === "all" || i.kind === kind);
  const visible = expanded ? shown : shown.slice(0, 25);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <button onClick={() => setKind("all")}
          className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${kind === "all" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:text-slate-900"}`}>
          All {data.total}
        </button>
        {KINDS.map((k) => (
          <button key={k} onClick={() => setKind(k)}
            className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${kind === k ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:text-slate-900"}`}>
            {KIND_LABEL[k]} {data.counts[k] ?? 0}
          </button>
        ))}
      </div>
      {shown.length === 0 ? <p className="text-sm text-slate-500">Nothing in this bucket. 🎉</p> : (
        <>
          <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
            {visible.map((i, idx) => (
              <div key={`${i.kind}-${i.deal_id}-${idx}`} className="flex flex-wrap items-start gap-2 bg-white px-3 py-2 text-xs">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${i.severity === "high" ? "bg-red-500" : "bg-amber-400"}`}
                  title={i.severity} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {i.company_id
                      ? <a href={companyUrl(i.company_id)} target="_blank" rel="noopener noreferrer" className="font-semibold text-slate-900 hover:text-blue-600">{i.company_name ?? `Company ${i.company_id}`}</a>
                      : <span className="italic text-slate-400">No account</span>}
                    <a href={dealUrl(i.deal_id)} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">deal ↗</a>
                    {i.owner_name && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{i.owner_name}</span>}
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">{KIND_LABEL[i.kind]}</span>
                  </div>
                  <div className="mt-0.5 text-slate-600">{i.detail}</div>
                  <div className="mt-0.5 text-slate-400">→ {i.suggestion}</div>
                </div>
              </div>
            ))}
          </div>
          {shown.length > visible.length && (
            <button onClick={() => setExpanded(true)} className="mt-2 text-xs font-semibold text-blue-600 hover:underline">
              Show all {shown.length}
            </button>
          )}
        </>
      )}
    </div>
  );
}
