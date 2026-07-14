"use client";

/**
 * Calling drill-down card (rep drawer): the layer under the Overview calling aggregates.
 * Unique contacts called → connected → who → outcome, unique rooftops → who within them,
 * and the raw call log — for the selected period (or custom range), lazy-fetched from
 * /api/rep/[ownerId]/calling (spine-backed; works for ALL six periods, unlike the snapshot's
 * narrow-period company_breakdown). Funnel tiles + outcome chips filter the tables client-side.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PeriodKey } from "../lib/sync/types";
import { CallingDetail, CalledContactRow, CalledRooftopRow } from "../lib/sync/calling";
import { contactUrl, companyUrl, callUrl } from "../config/hubspot";
import { PhoneCall, Users, PhoneIncoming, CalendarCheck, Building2, ExternalLink, ChevronRight, Download, Star } from "lucide-react";
import { CONNECTED_DISPOSITIONS, MEETING_SCHEDULED_GUID, ALL_DISPOSITIONS } from "../config/dispositions";
import { Surface, SectionTitle, Segmented, cn } from "./ui";

export type CallingTab = "contacts" | "rooftops" | "log";

const CONNECTED_LABELS = new Set(Object.values(CONNECTED_DISPOSITIONS));
const MEETING_LABEL = ALL_DISPOSITIONS[MEETING_SCHEDULED_GUID];

const fmt = (n: number) => n.toLocaleString("en-IN");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** ET timestamp for a call — day + time of day (managers read call logs by clock time). */
function etCallTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }) + " ET";
}

function OutcomeChip({ label, connected, count }: { label: string; connected: boolean; count?: number }) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px] font-medium",
      connected ? "bg-good-weak text-good" : "bg-surface-muted text-ink-muted")}>
      <span className="truncate">{label}</span>
      {count != null && <span className="font-mono font-bold tabular-nums">{fmt(count)}</span>}
    </span>
  );
}

export default function CallingCard({ ownerId, period, range, initialTab }: {
  ownerId: string;
  period: PeriodKey;
  range: { from: string; to: string } | null;
  initialTab?: CallingTab | null;
}) {
  const [data, setData] = useState<CallingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<CallingTab>(initialTab ?? "contacts");
  const [outcomeFilter, setOutcomeFilter] = useState<string | null>(null);
  const [connectedOnly, setConnectedOnly] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const query = range ? `from=${range.from}&to=${range.to}` : `period=${period}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setOutcomeFilter(null);
    setConnectedOnly(false);
    fetch(`/api/rep/${ownerId}/calling?${query}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? r.statusText);
        return r.json();
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setData(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ownerId, query]);

  // Opened from a specific Overview cell → land on that view.
  useEffect(() => {
    if (initialTab) {
      setTab(initialTab);
      requestAnimationFrame(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }, [initialTab]);

  const s = data?.summary;

  const pick = (t: CallingTab, opts?: { connected?: boolean; outcome?: string }) => {
    setTab(t);
    setConnectedOnly(opts?.connected ?? false);
    setOutcomeFilter(opts?.outcome ?? null);
  };

  const contacts = useMemo(() => (data?.contacts ?? []).filter((c) =>
    (!connectedOnly || c.connected > 0) && (!outcomeFilter || (c.outcomes[outcomeFilter] ?? 0) > 0)), [data, connectedOnly, outcomeFilter]);
  const rooftops = useMemo(() => (data?.rooftops ?? []).filter((r) =>
    (!connectedOnly || r.connected > 0) && (!outcomeFilter || (r.outcomes[outcomeFilter] ?? 0) > 0)), [data, connectedOnly, outcomeFilter]);
  const log = useMemo(() => (data?.log ?? []).filter((l) =>
    (!connectedOnly || l.connected) && (!outcomeFilter || l.outcome === outcomeFilter)), [data, connectedOnly, outcomeFilter]);

  function exportCsv() {
    if (!data) return;
    const esc = (v: string | number | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    let head: string[], lines: string[];
    if (tab === "contacts") {
      head = ["Contact", "Title", "DM", "Company", "Dials", "Connected", "LastOutcome", "LastCall"];
      lines = contacts.map((c) => [esc(c.name), esc(c.title), c.dm ? "yes" : "", esc(c.company_name), c.calls, c.connected, esc(c.last_outcome), esc(etCallTime(c.last_ms))].join(","));
    } else if (tab === "rooftops") {
      head = ["Rooftop", "Dials", "ContactsCalled", "Connected", "Meetings", "LastCall"];
      lines = rooftops.map((r) => [esc(r.name), r.calls, r.contacts.length, r.connected, r.meetings, esc(etCallTime(r.last_ms))].join(","));
    } else {
      head = ["Time", "Contact", "Company", "Outcome", "Connected"];
      lines = log.map((l) => [esc(etCallTime(l.ts_ms)), esc(l.contact_name), esc(l.company_name), esc(l.outcome), l.connected ? "yes" : "no"].join(","));
    }
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `calling-${ownerId}-${range ? `${range.from}_${range.to}` : period}-${tab}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div ref={cardRef}>
      <Surface className="p-4">
        <SectionTitle right={s ? (
          <span className="text-[11px] tabular-nums text-ink-subtle">
            {fmt(s.calls)} dials · {pct(s.connect_rate)} connect{s.no_disposition > 0 ? ` · ${fmt(s.no_disposition)} no disposition` : ""}
            {s.unattributed_calls > 0 ? ` · ${fmt(s.unattributed_calls)} unattributed` : ""}
          </span>
        ) : undefined}>
          Calling drill-down
        </SectionTitle>

        {loading && <p className="mt-3 text-sm text-ink-subtle">Loading calls…</p>}
        {error && <p className="mt-3 text-sm font-medium text-warn">⚠ {error}</p>}
        {!loading && !error && data && s && (
          s.calls === 0 ? <p className="mt-3 text-sm text-ink-subtle">No calls this period.</p> : (
            <>
              {/* Contact funnel: dials → unique contacts → connected → meetings (+ rooftop reach) */}
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                {([
                  { l: "Dials", v: s.calls, icon: PhoneCall, tint: "text-primary", sub: `${fmt(s.connected_calls)} connected`, go: () => pick("log") },
                  { l: "Contacts called", v: s.unique_contacts, icon: Users, tint: "text-primary", sub: "unique", go: () => pick("contacts") },
                  { l: "Contacts connected", v: s.contacts_connected, icon: PhoneIncoming, tint: "text-good", sub: s.unique_contacts ? `${Math.round((s.contacts_connected / s.unique_contacts) * 100)}% of called` : "—", go: () => pick("contacts", { connected: true }) },
                  { l: "Meetings", v: s.meetings, icon: CalendarCheck, tint: "text-good", sub: "booked on calls", go: () => pick("contacts", { outcome: MEETING_LABEL }) },
                  { l: "Rooftops called", v: s.unique_rooftops, icon: Building2, tint: "text-primary", sub: `${fmt(s.rooftops_connected)} connected`, go: () => pick("rooftops") },
                ] as const).map((t) => {
                  const Icon = t.icon;
                  return (
                    <button key={t.l} onClick={t.go}
                      className="rounded-xl border border-line px-3 py-2.5 text-left transition hover:border-line-strong hover:bg-surface-muted"
                      title={`Show ${t.l.toLowerCase()}`}>
                      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
                        <Icon className={cn("h-3 w-3", t.tint)} />{t.l}
                      </div>
                      <div className={cn("font-mono text-xl font-bold tabular-nums", t.tint)}>{fmt(t.v)}</div>
                      <div className="text-[10.5px] tabular-nums text-ink-subtle">{t.sub}</div>
                    </button>
                  );
                })}
              </div>

              {/* Outcome chips — click filters the active view */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {data.outcomes.map((o) => (
                  <button key={o.label} onClick={() => setOutcomeFilter((f) => (f === o.label ? null : o.label))}
                    title={`${fmt(o.contacts)} unique contact${o.contacts === 1 ? "" : "s"} — click to filter`}
                    className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold transition ring-1 ring-inset",
                      outcomeFilter === o.label ? "bg-ink text-white ring-ink"
                        : o.connected ? "bg-good-weak text-good ring-good/20 hover:brightness-95"
                        : "bg-surface-muted text-ink-muted ring-line hover:text-ink")}>
                    {o.label} <span className="font-mono tabular-nums">{fmt(o.count)}</span>
                  </button>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Segmented options={[["contacts", `Contacts (${fmt(contacts.length)})`], ["rooftops", `Rooftops (${fmt(rooftops.length)})`], ["log", `Call log (${fmt(log.length)})`]]}
                  value={tab} onChange={(v) => setTab(v as CallingTab)} />
                <button onClick={() => setConnectedOnly((c) => !c)}
                  className={cn("rounded-lg px-2.5 py-1 text-xs font-semibold transition",
                    connectedOnly ? "bg-good text-white" : "bg-surface-muted text-ink-muted hover:text-ink")}>
                  Connected only
                </button>
                {(outcomeFilter || connectedOnly) && (
                  <button onClick={() => { setOutcomeFilter(null); setConnectedOnly(false); }}
                    className="rounded-lg bg-surface-muted px-2 py-1 text-xs font-semibold text-ink-muted transition hover:text-ink">✕ Clear filters</button>
                )}
                <button onClick={exportCsv} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-muted transition hover:text-ink">
                  <Download className="h-3 w-3" /> CSV
                </button>
              </div>

              <div className="mt-2 max-h-96 overflow-y-auto scroll-y">
                {tab === "contacts" && <ContactsView rows={contacts} />}
                {tab === "rooftops" && <RooftopsView rows={rooftops} />}
                {tab === "log" && <LogView rows={log} truncated={data.log_truncated} />}
              </div>
            </>
          )
        )}
      </Surface>
    </div>
  );
}

function ContactsView({ rows }: { rows: CalledContactRow[] }) {
  if (rows.length === 0) return <p className="py-3 text-sm text-ink-subtle">No contacts match.</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="grid grid-cols-[1.6fr_1.2fr_0.45fr_0.45fr_1.2fr_0.9fr] gap-2 border-b border-line bg-surface-muted px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-ink-subtle">
        <span>Contact</span><span>Company</span><span className="text-right">Dials</span><span className="text-right">Conn</span><span>Last outcome</span><span className="text-right">Last call</span>
      </div>
      {rows.map((c) => (
        <div key={c.id} className="grid grid-cols-[1.6fr_1.2fr_0.45fr_0.45fr_1.2fr_0.9fr] items-center gap-2 border-b border-line/60 px-2.5 py-1.5 text-xs last:border-0">
          <span className="min-w-0">
            <a href={contactUrl(c.id)} target="_blank" rel="noopener noreferrer" className="group inline-flex max-w-full items-center gap-1 font-medium text-ink hover:text-primary">
              <span className="truncate">{c.name}</span>
              {c.dm && <Star className="h-3 w-3 shrink-0 fill-warm text-warm" aria-label="Decision maker" />}
              <ExternalLink className="h-3 w-3 shrink-0 text-primary opacity-0 transition group-hover:opacity-100" />
            </a>
            {c.title && <span className="block truncate text-[10px] text-ink-subtle">{c.title}</span>}
          </span>
          <span className="min-w-0 truncate text-ink-muted">
            {c.company_id ? <a href={companyUrl(c.company_id)} target="_blank" rel="noopener noreferrer" className="hover:text-primary">{c.company_name}</a> : "—"}
          </span>
          <span className="text-right font-mono tabular-nums text-ink">{fmt(c.calls)}</span>
          <span className={cn("text-right font-mono tabular-nums", c.connected > 0 ? "font-bold text-good" : "text-ink-subtle")}>{fmt(c.connected)}</span>
          <span className="min-w-0"><OutcomeChip label={c.last_outcome} connected={CONNECTED_LABELS.has(c.last_outcome)} /></span>
          <span className="text-right font-mono text-[10px] tabular-nums text-ink-subtle">{etCallTime(c.last_ms)}</span>
        </div>
      ))}
    </div>
  );
}

function RooftopsView({ rows }: { rows: CalledRooftopRow[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (rows.length === 0) return <p className="py-3 text-sm text-ink-subtle">No rooftops match.</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="grid grid-cols-[1.8fr_0.5fr_0.6fr_0.5fr_0.5fr_0.9fr] gap-2 border-b border-line bg-surface-muted px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-ink-subtle">
        <span>Rooftop</span><span className="text-right">Dials</span><span className="text-right">Contacts</span><span className="text-right">Conn</span><span className="text-right">Mtgs</span><span className="text-right">Last call</span>
      </div>
      {rows.map((r) => (
        <div key={r.id} className="border-b border-line/60 last:border-0">
          <div className="grid cursor-pointer grid-cols-[1.8fr_0.5fr_0.6fr_0.5fr_0.5fr_0.9fr] items-center gap-2 px-2.5 py-1.5 text-xs transition hover:bg-surface-muted"
            onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}>
            <span className="flex min-w-0 items-center gap-1">
              <ChevronRight className={cn("h-3 w-3 shrink-0 text-ink-subtle transition-transform", open[r.id] && "rotate-90")} />
              <span className="truncate font-medium text-ink">{r.name}</span>
              <a href={companyUrl(r.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Open in HubSpot">
                <ExternalLink className="h-3 w-3 shrink-0 text-primary" />
              </a>
            </span>
            <span className="text-right font-mono tabular-nums text-ink">{fmt(r.calls)}</span>
            <span className="text-right font-mono tabular-nums text-ink-muted">{fmt(r.contacts.length)}</span>
            <span className={cn("text-right font-mono tabular-nums", r.connected > 0 ? "font-bold text-good" : "text-ink-subtle")}>{fmt(r.connected)}</span>
            <span className={cn("text-right font-mono tabular-nums", r.meetings > 0 ? "font-bold text-good" : "text-ink-subtle")}>{fmt(r.meetings)}</span>
            <span className="text-right font-mono text-[10px] tabular-nums text-ink-subtle">{etCallTime(r.last_ms)}</span>
          </div>
          {open[r.id] && (
            <div className="space-y-1 bg-surface-muted/50 px-2.5 py-1.5 pl-7">
              {r.contacts.length === 0 && <p className="text-[11px] text-ink-subtle">No contact resolved on these calls.</p>}
              {r.contacts.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                  <a href={contactUrl(c.id)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-ink hover:text-primary">
                    {c.name}{c.dm && <Star className="h-2.5 w-2.5 fill-warm text-warm" />}
                  </a>
                  {c.title && <span className="truncate text-ink-subtle">{c.title}</span>}
                  <span className="font-mono tabular-nums text-ink-muted">{fmt(c.calls)} dial{c.calls === 1 ? "" : "s"}</span>
                  {Object.entries(c.outcomes).map(([label, n]) => (
                    <OutcomeChip key={label} label={label} count={n} connected={CONNECTED_LABELS.has(label)} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function LogView({ rows, truncated }: { rows: { id: string; ts_ms: number; contact_id: string | null; contact_name: string | null; company_id: string | null; company_name: string | null; outcome: string; connected: boolean }[]; truncated: boolean }) {
  if (rows.length === 0) return <p className="py-3 text-sm text-ink-subtle">No calls match.</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="grid grid-cols-[0.9fr_1.4fr_1.3fr_1.4fr_0.3fr] gap-2 border-b border-line bg-surface-muted px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-ink-subtle">
        <span>Time</span><span>Contact</span><span>Company</span><span>Outcome</span><span />
      </div>
      {rows.map((l) => (
        <div key={l.id} className="grid grid-cols-[0.9fr_1.4fr_1.3fr_1.4fr_0.3fr] items-center gap-2 border-b border-line/60 px-2.5 py-1.5 text-xs last:border-0">
          <span className="font-mono text-[10px] tabular-nums text-ink-subtle">{etCallTime(l.ts_ms)}</span>
          <span className="min-w-0 truncate text-ink">
            {l.contact_id ? <a href={contactUrl(l.contact_id)} target="_blank" rel="noopener noreferrer" className="hover:text-primary">{l.contact_name}</a> : "—"}
          </span>
          <span className="min-w-0 truncate text-ink-muted">
            {l.company_id ? <a href={companyUrl(l.company_id)} target="_blank" rel="noopener noreferrer" className="hover:text-primary">{l.company_name}</a> : "—"}
          </span>
          <span className="min-w-0"><OutcomeChip label={l.outcome} connected={l.connected} /></span>
          <a href={callUrl(l.id)} target="_blank" rel="noopener noreferrer" title="Open call in HubSpot" className="justify-self-end">
            <ExternalLink className="h-3 w-3 text-primary" />
          </a>
        </div>
      ))}
      {truncated && <p className="px-2.5 py-1.5 text-[11px] text-ink-subtle">Log capped — the newest 800 calls are shown; summary counts cover everything.</p>}
    </div>
  );
}
