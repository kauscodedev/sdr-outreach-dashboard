"use client";

/**
 * SDR Daily Focus (Intelligence hub): one prioritized "work this today" list per rep — the
 * agent's hot-account verdicts, scheduled demos at risk, and revival candidates (warm threads
 * going quiet), each with a grounded why + next step and shared action tracking.
 */
import { useCallback, useEffect, useState } from "react";
import { Flame, CalendarClock, RotateCcw, History, ExternalLink, Check, Clock, Loader2, PlayCircle } from "lucide-react";
import { FocusResponse, FocusItem, FocusBucket, SIGNAL_LABEL_META } from "../lib/intel/types";
import { companyUrl } from "../config/hubspot";
import { markInProgress, markCompleted, snoozeWatch, resetWatch } from "../lib/agent/actions-client";
import { Surface, Segmented, cn } from "./ui";
import AccountTimeline from "./AccountTimeline";

const BUCKET_META: Record<FocusBucket, { label: string; chip: string; icon: typeof Flame }> = {
  at_risk_demo: { label: "Demo at risk", chip: "bg-hot-weak text-hot", icon: CalendarClock },
  watch: { label: "Hot account", chip: "bg-warm-weak text-warm", icon: Flame },
  revive: { label: "Revive", chip: "bg-cold-weak text-cold", icon: RotateCcw },
};

const PRIO_DOT: Record<string, string> = { high: "bg-hot", medium: "bg-warm", low: "bg-cold" };

interface NextStepDetails { action?: string; contact_name?: string; contact_title?: string; channel?: string; helper_text?: string }

function parseNextStep(raw: string | null): { text: string | null; details: NextStepDetails | null } {
  if (!raw) return { text: null, details: null };
  if (raw.trim().startsWith("{")) {
    try {
      const d = JSON.parse(raw) as NextStepDetails;
      return { text: d.action ?? null, details: d };
    } catch { /* fall through */ }
  }
  return { text: raw, details: null };
}

function etDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit" });
}

export default function FocusList({ repOptions, defaultRep }: {
  repOptions: { id: string; name: string }[];
  defaultRep: string | null;
}) {
  const [rep, setRep] = useState<string>(defaultRep ?? repOptions[0]?.id ?? "");
  const [data, setData] = useState<FocusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bucketFilter, setBucketFilter] = useState<"" | FocusBucket>("");
  const [timelineFor, setTimelineFor] = useState<{ id: string; name: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!rep) return;
    setLoading(true);
    setError(null);
    fetch(`/api/intel/focus?rep=${rep}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? r.statusText); return r.json(); })
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [rep]);

  useEffect(() => { load(); }, [load]);

  const setStatusLocal = (accountId: string, actionStatus: FocusItem["actionStatus"]) => {
    setData((d) => d ? { ...d, items: d.items.map((i) => i.accountId === accountId ? { ...i, actionStatus } : i) } : d);
  };

  const items = (data?.items ?? []).filter((i) => !bucketFilter || i.bucket === bucketFilter);
  const counts = (data?.items ?? []).reduce((m, i) => ((m[i.bucket] = (m[i.bucket] ?? 0) + 1), m), {} as Record<string, number>);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {repOptions.length > 1 && (
          <select value={rep} onChange={(e) => setRep(e.target.value)}
            className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink-muted shadow-card outline-none focus:ring-2 focus:ring-primary/30">
            {repOptions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        <Segmented
          options={[["", `All (${data?.items.length ?? 0})`],
            ["at_risk_demo", `Demos at risk (${counts.at_risk_demo ?? 0})`],
            ["watch", `Hot (${counts.watch ?? 0})`],
            ["revive", `Revive (${counts.revive ?? 0})`]]}
          value={bucketFilter} onChange={(v) => setBucketFilter(v as typeof bucketFilter)} />
        {data?.repName && <span className="ml-auto text-[11px] text-ink-subtle">Focus list for <span className="font-semibold text-ink">{data.repName}</span> · refreshed live from the spine</span>}
      </div>

      {loading && <Surface className="p-4"><p className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" /> Building the focus list…</p></Surface>}
      {error && <Surface className="p-4"><p className="text-sm font-medium text-warn">⚠ {error}</p></Surface>}
      {!loading && !error && items.length === 0 && (
        <Surface className="p-6 text-center">
          <Check className="mx-auto h-8 w-8 text-good" />
          <p className="mt-2 text-sm font-semibold text-ink">Nothing needs attention in this view</p>
          <p className="mt-1 text-xs text-ink-subtle">Hot accounts, at-risk demos, and revivable threads land here automatically.</p>
        </Surface>
      )}

      <div className="space-y-2">
        {items.map((item) => {
          const meta = BUCKET_META[item.bucket];
          const Icon = meta.icon;
          const ns = parseNextStep(item.nextStep);
          const dimmed = item.actionStatus === "completed" || item.actionStatus === "snoozed";
          const isOpen = expanded === item.accountId;
          return (
            <Surface key={item.accountId} className={cn("p-3.5 transition", dimmed && "opacity-50")}>
              <div className="flex flex-wrap items-start gap-3">
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", PRIO_DOT[item.priority])} title={`${item.priority} priority`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold", meta.chip)}>
                      <Icon className="h-3 w-3" />{meta.label}
                    </span>
                    <button onClick={() => setTimelineFor({ id: item.accountId, name: item.accountName })}
                      className="truncate text-sm font-semibold text-ink hover:text-primary" title="Open account history">
                      {item.accountName}
                    </button>
                    <a href={companyUrl(item.accountId)} target="_blank" rel="noopener noreferrer" title="Open in HubSpot">
                      <ExternalLink className="h-3 w-3 text-primary" />
                    </a>
                    <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-subtle">last touch {etDate(item.lastMs)}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">{item.why}</p>
                  {ns.text && (
                    <p className="mt-1 text-xs text-ink">
                      <span className="font-semibold text-primary">Next:</span> {ns.text}
                      {ns.details?.contact_name && <span className="text-ink-muted"> → {ns.details.contact_name}{ns.details.contact_title ? ` (${ns.details.contact_title})` : ""}</span>}
                      {ns.details?.channel && <span className="ml-1 rounded bg-surface-muted px-1 py-0.5 text-[10px] font-medium text-ink-muted">{ns.details.channel}</span>}
                    </p>
                  )}
                  {item.signals.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {item.signals.map((s, i) => (
                        <span key={i} title={s.quote}
                          className={cn("max-w-[340px] truncate rounded px-1.5 py-0.5 text-[10px] font-medium",
                            SIGNAL_LABEL_META[s.label].tone === "good" ? "bg-good-weak text-good" :
                            SIGNAL_LABEL_META[s.label].tone === "danger" ? "bg-hot-weak text-hot" :
                            SIGNAL_LABEL_META[s.label].tone === "warn" ? "bg-warn-weak text-warn" : "bg-surface-muted text-ink-muted")}>
                          {SIGNAL_LABEL_META[s.label].label}: &ldquo;{s.quote}&rdquo;
                        </span>
                      ))}
                    </div>
                  )}
                  {ns.details?.helper_text && (
                    <div className="mt-1.5">
                      <button onClick={() => setExpanded(isOpen ? null : item.accountId)} className="text-[11px] font-semibold text-primary hover:underline">
                        {isOpen ? "Hide draft" : "Show call script / email draft"}
                      </button>
                      {isOpen && (
                        <pre className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-muted/60 p-2.5 font-sans text-[11px] leading-relaxed text-ink-muted">{ns.details.helper_text}</pre>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  {item.actionStatus === "not_started" && (
                    <button onClick={() => { markInProgress(item.accountId); setStatusLocal(item.accountId, "in_progress"); }}
                      title="Mark in progress" className="rounded-lg p-1.5 text-primary transition hover:bg-primary-weak"><PlayCircle className="h-4 w-4" /></button>
                  )}
                  {(item.actionStatus === "not_started" || item.actionStatus === "in_progress") && (
                    <>
                      <button onClick={() => { markCompleted(item.accountId); setStatusLocal(item.accountId, "completed"); }}
                        title="Mark done" className="rounded-lg p-1.5 text-good transition hover:bg-good-weak"><Check className="h-4 w-4" /></button>
                      <button onClick={() => { snoozeWatch(item.accountId, 3); setStatusLocal(item.accountId, "snoozed"); }}
                        title="Snooze 3 days" className="rounded-lg p-1.5 text-ink-subtle transition hover:bg-surface-muted"><Clock className="h-4 w-4" /></button>
                    </>
                  )}
                  {dimmed && (
                    <button onClick={() => { resetWatch(item.accountId); setStatusLocal(item.accountId, "not_started"); }}
                      title="Reopen" className="rounded-lg p-1.5 text-ink-subtle transition hover:bg-surface-muted"><RotateCcw className="h-4 w-4" /></button>
                  )}
                  <button onClick={() => setTimelineFor({ id: item.accountId, name: item.accountName })}
                    title="Account history" className="rounded-lg p-1.5 text-ink-subtle transition hover:bg-surface-muted"><History className="h-4 w-4" /></button>
                </div>
              </div>
            </Surface>
          );
        })}
      </div>

      {timelineFor && <AccountTimeline account={timelineFor} onClose={() => setTimelineFor(null)} />}
    </div>
  );
}
