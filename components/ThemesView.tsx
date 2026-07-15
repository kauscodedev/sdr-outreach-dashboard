"use client";

/**
 * Themes (manager lens, Intelligence hub): what prospects keep saying — top objections,
 * competitor mentions, buying signals, risks — mined nightly from call/email content by the
 * signals engine. Every count opens to verbatim quotes with account links. Hand-built bars
 * (design tokens, no chart lib), matching the dashboard's chart conventions.
 */
import { useEffect, useMemo, useState } from "react";
import { MessageSquareWarning, Loader2 } from "lucide-react";
import { ThemesResponse, ThemeRow, SignalLabel, SIGNAL_LABEL_META } from "../lib/intel/types";
import { Surface, SectionTitle, Segmented, cn } from "./ui";
import AccountTimeline from "./AccountTimeline";

const WINDOWS: [string, string][] = [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]];
const TREND_LABELS: [SignalLabel, string][] = [
  ["objection", "Objections"],
  ["competitor_mention", "Competitors"],
  ["buying_signal", "Buying signals"],
  ["risk_phrase", "Risks"],
  ["pricing_question", "Pricing questions"],
];

const TONE_TEXT: Record<string, string> = { warn: "text-warn", good: "text-good", danger: "text-hot", neutral: "text-primary" };
const TONE_BG: Record<string, string> = { warn: "bg-warn", good: "bg-good", danger: "bg-hot", neutral: "bg-primary" };
const TONE_CHIP: Record<string, string> = { warn: "bg-warn-weak text-warn", good: "bg-good-weak text-good", danger: "bg-hot-weak text-hot", neutral: "bg-primary-weak text-primary" };

function etDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit" });
}

export default function ThemesView({ scoped }: { scoped: boolean }) {
  const [days, setDays] = useState("30");
  const [label, setLabel] = useState<SignalLabel>("objection");
  const [scope, setScope] = useState<"mine" | "all">(scoped ? "mine" : "all");
  const [data, setData] = useState<ThemesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timelineFor, setTimelineFor] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const to = new Date();
    const from = new Date(Date.now() - (Number(days) - 1) * 86400000);
    const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    fetch(`/api/intel/themes?from=${ymd(from)}&to=${ymd(to)}&label=${label}&scope=${scope}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? r.statusText); return r.json(); })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [days, label, scope]);

  const byLabel = useMemo(() => {
    const m = new Map<SignalLabel, ThemeRow[]>();
    for (const t of data?.themes ?? []) {
      const list = m.get(t.label) ?? [];
      list.push(t);
      m.set(t.label, list);
    }
    return m;
  }, [data]);

  const weekly = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of data?.trend ?? []) m.set(p.week_start, (m.get(p.week_start) ?? 0) + p.mentions);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);
  const weeklyMax = Math.max(1, ...weekly.map(([, n]) => n));

  const totalSignals = (data?.themes ?? []).reduce((s, t) => s + t.mentions, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented options={WINDOWS} value={days} onChange={setDays} />
        {scoped && <Segmented tone="good" options={[["mine", "My reps"], ["all", "All reps"]]} value={scope} onChange={(v) => setScope(v as "mine" | "all")} />}
        <span className="ml-auto text-[11px] tabular-nums text-ink-subtle">
          {data ? `${totalSignals.toLocaleString("en-IN")} signals · ${data.from} → ${data.to}` : ""}
        </span>
      </div>

      {loading && <Surface className="p-4"><p className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading themes…</p></Surface>}
      {error && <Surface className="p-4"><p className="text-sm font-medium text-warn">⚠ {error}</p></Surface>}

      {!loading && !error && data && totalSignals === 0 && (
        <Surface className="p-6 text-center">
          <MessageSquareWarning className="mx-auto h-8 w-8 text-ink-subtle" />
          <p className="mt-2 text-sm font-semibold text-ink">No signals in this window yet</p>
          <p className="mt-1 text-xs text-ink-subtle">The nightly scan mines objections, competitors, and buying signals from new call/email content. The historical backfill fills this view over its first runs.</p>
        </Surface>
      )}

      {!loading && !error && data && totalSignals > 0 && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {[...byLabel.entries()].map(([lbl, rows]) => {
              const meta = SIGNAL_LABEL_META[lbl];
              const total = rows.reduce((s, r) => s + r.mentions, 0);
              const max = Math.max(1, ...rows.map((r) => r.mentions));
              return (
                <Surface key={lbl} className="p-4">
                  <SectionTitle right={<span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums", TONE_CHIP[meta.tone])}>{total.toLocaleString("en-IN")}</span>}>
                    {meta.label}s
                  </SectionTitle>
                  <ul className="mt-3 space-y-1.5">
                    {rows.slice(0, 8).map((r) => (
                      <li key={r.category} className="text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-medium text-ink">{r.category}</span>
                          <span className="shrink-0 font-mono tabular-nums text-ink-subtle">
                            {r.mentions.toLocaleString("en-IN")} · {r.accounts.toLocaleString("en-IN")} accts · {r.reps.toLocaleString("en-IN")} reps
                          </span>
                        </div>
                        <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                          <div className={cn("h-full", TONE_BG[meta.tone])} style={{ width: `${(r.mentions / max) * 100}%` }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </Surface>
              );
            })}
          </div>

          <Surface className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle>Weekly trend</SectionTitle>
              <Segmented options={TREND_LABELS.map(([k, l]) => [k, l] as [string, string])} value={label} onChange={(v) => setLabel(v as SignalLabel)} />
            </div>
            {weekly.length === 0 ? <p className="mt-3 text-sm text-ink-subtle">No {SIGNAL_LABEL_META[label].label.toLowerCase()} signals in this window.</p> : (
              <div className="mt-4 flex items-end gap-2" style={{ height: 110 }}>
                {weekly.map(([week, n]) => (
                  <div key={week} className="flex flex-1 flex-col items-center justify-end gap-1" title={`Week of ${week}: ${n}`}>
                    <span className="font-mono text-[10px] tabular-nums text-ink-subtle">{n}</span>
                    <div className={cn("w-full max-w-[48px] rounded-t", TONE_BG[SIGNAL_LABEL_META[label].tone])} style={{ height: Math.max(3, (n / weeklyMax) * 80) }} />
                    <span className="font-mono text-[9px] tabular-nums text-ink-subtle">{week.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
          </Surface>

          {data.examples.length > 0 && (
            <Surface className="p-4">
              <SectionTitle>What they actually said</SectionTitle>
              <div className="mt-3 grid gap-2 lg:grid-cols-2">
                {data.examples.map((e, i) => {
                  const meta = SIGNAL_LABEL_META[e.label];
                  return (
                    <div key={i} className="rounded-lg border border-line/70 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className={cn("rounded px-1.5 py-0.5 font-semibold", TONE_CHIP[meta.tone])}>{e.category ?? meta.label}</span>
                        {e.accountId ? (
                          <button onClick={() => setTimelineFor({ id: e.accountId!, name: e.accountName ?? e.accountId! })}
                            className="font-semibold text-ink hover:text-primary" title="Open account history">
                            {e.accountName ?? `Account ${e.accountId}`}
                          </button>
                        ) : <span className="text-ink-subtle">Unattributed</span>}
                        <span className="ml-auto font-mono tabular-nums text-ink-subtle">{etDate(e.tsMs)}</span>
                      </div>
                      <p className="mt-1 text-xs italic leading-relaxed text-ink-muted">&ldquo;{e.quote}&rdquo;</p>
                    </div>
                  );
                })}
              </div>
            </Surface>
          )}
        </>
      )}

      {timelineFor && <AccountTimeline account={timelineFor} onClose={() => setTimelineFor(null)} />}
    </div>
  );
}
