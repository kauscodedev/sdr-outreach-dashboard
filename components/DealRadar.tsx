"use client";

/**
 * AE Deal Radar (Intelligence hub): active deals ranked by how loudly they're asking for
 * attention — recent risk language mined from calls/emails, days stuck in stage (event ledger),
 * and Deal Health. Every risk chip carries the verbatim quote; rows link to HubSpot + the
 * account history drawer.
 */
import { useEffect, useState } from "react";
import { Radar, ExternalLink, History, Loader2, ShieldAlert } from "lucide-react";
import { RadarResponse, RadarDeal, SIGNAL_LABEL_META } from "../lib/intel/types";
import { dealUrl, companyUrl } from "../config/hubspot";
import { Surface, Segmented, DealHealthBadge, cn } from "./ui";
import AccountTimeline from "./AccountTimeline";

const fmtAmt = (n: number | null) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);

function etDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit" });
}

export default function DealRadar({ scoped, names }: { scoped: boolean; names: Record<string, string> }) {
  const [scope, setScope] = useState<"mine" | "all">(scoped ? "mine" : "all");
  const [data, setData] = useState<RadarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [riskOnly, setRiskOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [timelineFor, setTimelineFor] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/intel/radar?scope=${scope}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? r.statusText); return r.json(); })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [scope]);

  const deals = (data?.deals ?? []).filter((d) => !riskOnly || d.riskSignals.length > 0);
  const withRisk = (data?.deals ?? []).filter((d) => d.riskSignals.length > 0).length;
  const red = (data?.deals ?? []).filter((d) => d.health === "red").length;
  const stale = (data?.deals ?? []).filter((d) => d.stale).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {scoped && <Segmented tone="good" options={[["mine", "My deals"], ["all", "All deals"]]} value={scope} onChange={(v) => setScope(v as "mine" | "all")} />}
        <button onClick={() => setRiskOnly((r) => !r)}
          className={cn("inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold transition",
            riskOnly ? "bg-hot text-white" : "bg-hot-weak text-hot hover:brightness-95")}>
          <ShieldAlert className="h-3.5 w-3.5" /> Risk voiced ({withRisk})
        </button>
        <span className="ml-auto text-[11px] tabular-nums text-ink-subtle">
          {data ? `${data.deals.length} active deals · ${red} red · ${stale} stuck >14d` : ""}
        </span>
      </div>

      {loading && <Surface className="p-4"><p className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" /> Scanning the pipeline…</p></Surface>}
      {error && <Surface className="p-4"><p className="text-sm font-medium text-warn">⚠ {error}</p></Surface>}
      {!loading && !error && deals.length === 0 && (
        <Surface className="p-6 text-center">
          <Radar className="mx-auto h-8 w-8 text-ink-subtle" />
          <p className="mt-2 text-sm font-semibold text-ink">No deals match this view</p>
          <p className="mt-1 text-xs text-ink-subtle">Risk chips appear when the nightly scan finds objections, competitor mentions, or risk language on a live deal&rsquo;s account.</p>
        </Surface>
      )}

      {deals.length > 0 && (
        <Surface className="overflow-hidden">
          <div className="scroll-x">
            <table className="w-full min-w-[980px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-muted text-left text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
                  <th className="px-3 py-2">Account / Deal</th>
                  <th className="px-3 py-2">Stage</th>
                  <th className="px-3 py-2 text-right">Days in stage</th>
                  <th className="px-3 py-2">Health</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">AE</th>
                  <th className="px-3 py-2">Risk voiced</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {deals.map((d: RadarDeal) => {
                  const isOpen = expanded === d.dealId;
                  return (
                    <tr key={d.dealId} className="border-b border-line/70 align-top transition-colors last:border-0 hover:bg-primary-weak/40">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {d.accountId ? (
                            <button onClick={() => setTimelineFor({ id: d.accountId!, name: d.accountName ?? d.accountId! })}
                              className="max-w-[240px] truncate font-semibold text-ink hover:text-primary" title="Open account history">
                              {d.accountName ?? `Account ${d.accountId}`}
                            </button>
                          ) : <span className="text-ink-subtle">No account linked</span>}
                          <a href={dealUrl(d.dealId)} target="_blank" rel="noopener noreferrer" title="Open deal in HubSpot">
                            <ExternalLink className="h-3 w-3 text-primary" />
                          </a>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-ink-muted">{d.stageLabel}</td>
                      <td className={cn("px-3 py-2.5 text-right font-mono tabular-nums", d.stale ? "font-bold text-warn" : "text-ink-muted")}>
                        {d.daysInStage ?? "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        {d.health ? <span title={d.healthReason ?? undefined}><DealHealthBadge health={d.health} /></span> : <span className="text-xs text-ink-subtle">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink">{fmtAmt(d.amount)}</td>
                      <td className="px-3 py-2.5 text-xs text-ink-muted">{d.aeId ? (names[d.aeId] ?? `ID:${d.aeId}`) : "—"}</td>
                      <td className="px-3 py-2.5">
                        {d.riskSignals.length === 0 ? <span className="text-xs text-ink-subtle">—</span> : (
                          <div className="space-y-1">
                            {(isOpen ? d.riskSignals : d.riskSignals.slice(0, 1)).map((s, i) => (
                              <div key={i} className="max-w-[340px] text-[11px]">
                                <span className={cn("mr-1 rounded px-1 py-0.5 font-semibold",
                                  SIGNAL_LABEL_META[s.label].tone === "danger" ? "bg-hot-weak text-hot" : "bg-warn-weak text-warn")}>
                                  {s.category ?? SIGNAL_LABEL_META[s.label].label}
                                </span>
                                <span className="italic text-ink-muted">&ldquo;{s.quote}&rdquo;</span>
                                <span className="ml-1 font-mono text-[10px] tabular-nums text-ink-subtle">{etDate(s.tsMs)}</span>
                              </div>
                            ))}
                            {d.riskSignals.length > 1 && (
                              <button onClick={() => setExpanded(isOpen ? null : d.dealId)} className="text-[11px] font-semibold text-primary hover:underline">
                                {isOpen ? "less" : `+${d.riskSignals.length - 1} more`}
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {d.accountId && (
                          <button onClick={() => setTimelineFor({ id: d.accountId!, name: d.accountName ?? d.accountId! })}
                            title="Account history" className="rounded-lg p-1.5 text-ink-subtle transition hover:bg-surface-muted"><History className="h-4 w-4" /></button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}

      {timelineFor && <AccountTimeline account={timelineFor} onClose={() => setTimelineFor(null)} />}
    </div>
  );
}
