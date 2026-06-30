"use client";

import { useMemo, useState } from "react";
import {
  PERIOD_KEYS,
  PERIOD_LABELS,
  NARROW_PERIODS,
  PeriodKey,
  PeriodMetrics,
  RepData,
  Snapshot,
  DailyPoint,
} from "../lib/sync/types";
import { CONNECTED_DISPOSITIONS } from "../config/dispositions";
import { companyUrl, contactUrl } from "../config/hubspot";

const CONNECTED_LABELS = new Set(Object.values(CONNECTED_DISPOSITIONS));

type SortKey =
  | "name"
  | "unique_contacts"
  | "unique_companies"
  | "avg_contacts_per_company"
  | "calls_total"
  | "connect_rate"
  | "emails_sent"
  | "activity";

interface Row {
  ownerId: string;
  name: string;
  data: RepData;
  m: PeriodMetrics;
  activity: number;
}

const fmt = (n: number) => n.toLocaleString("en-IN");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function istStamp(iso: string): string {
  if (!iso) return "never";
  try {
    return (
      new Date(iso).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }) + " IST"
    );
  } catch {
    return iso;
  }
}

export default function Dashboard({ snapshot }: { snapshot: Snapshot }) {
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [repFilter, setRepFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("activity");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<string | null>(null);

  const allRows = useMemo<Row[]>(() => {
    return Object.entries(snapshot.reps).map(([ownerId, data]) => {
      const m = data.periods[period];
      return {
        ownerId,
        name: snapshot.owner_names[ownerId] ?? `ID:${ownerId}`,
        data,
        m,
        activity: m.calls.total + m.emails.sent,
      };
    });
  }, [snapshot, period]);

  const rows = useMemo<Row[]>(() => {
    const filtered = repFilter === "all" ? allRows : allRows.filter((r) => r.ownerId === repFilter);
    const val = (r: Row): number | string => {
      switch (sortKey) {
        case "name":
          return r.name.toLowerCase();
        case "unique_contacts":
          return r.m.unique_contacts;
        case "unique_companies":
          return r.m.unique_companies;
        case "avg_contacts_per_company":
          return r.m.avg_contacts_per_company;
        case "calls_total":
          return r.m.calls.total;
        case "connect_rate":
          return r.m.calls.connect_rate;
        case "emails_sent":
          return r.m.emails.sent;
        case "activity":
          return r.activity;
      }
    };
    return [...filtered].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [allRows, repFilter, sortKey, sortDir]);

  const summary = useMemo(() => {
    const acc = { contacts: 0, companies: 0, calls: 0, connected: 0, callDenom: 0, emails: 0, active: 0 };
    for (const r of rows) {
      acc.contacts += r.m.unique_contacts;
      acc.companies += r.m.unique_companies;
      acc.calls += r.m.calls.total;
      acc.connected += r.m.calls.connected;
      acc.callDenom += r.m.calls.connected + r.m.calls.not_connected;
      acc.emails += r.m.emails.sent;
      if (r.activity > 0) acc.active++;
    }
    return { ...acc, connectRate: acc.callDenom ? acc.connected / acc.callDenom : 0 };
  }, [rows]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  function exportCsv() {
    const head = [
      "Rep", "Unique Contacts", "Unique Companies", "Contacts per Company",
      "Calls", "Connected", "Not Connected", "Connect Rate", "Emails Sent", "Bounced", "Total Activity",
    ];
    const lines = rows.map((r) =>
      [
        `"${r.name.replace(/"/g, '""')}"`, r.m.unique_contacts, r.m.unique_companies, r.m.avg_contacts_per_company,
        r.m.calls.total, r.m.calls.connected, r.m.calls.not_connected, r.m.calls.connect_rate,
        r.m.emails.sent, r.m.emails.bounced, r.activity,
      ].join(","),
    );
    const csv = [head.join(","), ...lines].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `sdr-outreach-${period}-${snapshot.today_ist || "snapshot"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const hasData = !!snapshot.generated_at_utc;

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">SDR Outreach Coverage</h1>
          <p className="mt-1 text-sm text-slate-500">
            Outbound calls &amp; emails per rep · unique contacts &amp; companies tapped · IST periods (week starts Monday)
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          <div>
            Refreshed: <span className="font-medium text-blue-600">{istStamp(snapshot.generated_at_utc)}</span>
          </div>
          <div>
            Window {snapshot.window.start_ist || "—"} → {snapshot.window.end_ist || "—"} ·{" "}
            {fmt(snapshot.totals.calls)} calls + {fmt(snapshot.totals.emails)} emails
          </div>
        </div>
      </header>

      {!hasData && (
        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">
          No snapshot data yet. Run <code className="rounded bg-slate-100 px-1.5 py-0.5 text-blue-600">npm run sync</code>.
        </div>
      )}

      {hasData && snapshot.sources && !snapshot.sources.emails && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠️ Emails not included — token lacks the{" "}
          <code className="rounded bg-amber-100 px-1.5 py-0.5">connected-email-data-access</code> scope. Showing calls only.
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
          {PERIOD_KEYS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                period === p ? "bg-blue-600 font-medium text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        <select
          value={repFilter}
          onChange={(e) => setRepFilter(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 shadow-sm"
        >
          <option value="all">All reps ({allRows.length})</option>
          {[...allRows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => (
            <option key={r.ownerId} value={r.ownerId}>{r.name}</option>
          ))}
        </select>

        <button
          onClick={exportCsv}
          className="ml-auto rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 shadow-sm hover:bg-slate-100"
        >
          ↓ Export CSV
        </button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card label="Unique contacts" hint="summed per rep" value={fmt(summary.contacts)} />
        <Card label="Unique companies" hint="summed per rep" value={fmt(summary.companies)} />
        <Card label="Calls" value={fmt(summary.calls)} />
        <Card label="Connect rate" value={pct(summary.connectRate)} tone="emerald" />
        <Card label="Emails sent" value={fmt(summary.emails)} />
        <Card label="Active reps" hint={`of ${allRows.length}`} value={fmt(summary.active)} />
      </div>

      <div className="scroll-x rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[920px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <Th onClick={() => toggleSort("name")} active={sortKey === "name"} dir={sortDir}>Rep</Th>
              <Th right onClick={() => toggleSort("unique_contacts")} active={sortKey === "unique_contacts"} dir={sortDir}>Uniq Contacts</Th>
              <Th right onClick={() => toggleSort("unique_companies")} active={sortKey === "unique_companies"} dir={sortDir}>Uniq Companies</Th>
              <Th right onClick={() => toggleSort("avg_contacts_per_company")} active={sortKey === "avg_contacts_per_company"} dir={sortDir}>Contacts / Co</Th>
              <Th right onClick={() => toggleSort("calls_total")} active={sortKey === "calls_total"} dir={sortDir}>Calls</Th>
              <Th onClick={() => toggleSort("connect_rate")} active={sortKey === "connect_rate"} dir={sortDir}>Connect rate</Th>
              <Th right onClick={() => toggleSort("emails_sent")} active={sortKey === "emails_sent"} dir={sortDir}>Emails</Th>
              <Th right onClick={() => toggleSort("activity")} active={sortKey === "activity"} dir={sortDir}>Activity</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <RepRow
                key={r.ownerId}
                row={r}
                period={period}
                isOpen={expanded === r.ownerId}
                onToggle={() => setExpanded(expanded === r.ownerId ? null : r.ownerId)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-slate-400">
        “Connected” = a human was reached (voicemail / busy excluded). Per-company drill-down (with HubSpot links) is
        available for {NARROW_PERIODS.map((p) => PERIOD_LABELS[p]).join(", ")}. Owner reflects the current HubSpot owner;
        outbound only. Click a row to expand.
      </p>
    </main>
  );
}

function Card({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "emerald" }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "emerald" ? "text-emerald-600" : "text-slate-900"}`}>
        {value}
      </div>
      {hint && <div className="text-[10px] uppercase tracking-wide text-slate-400">{hint}</div>}
    </div>
  );
}

function Th({
  children, onClick, active, dir, right,
}: {
  children: React.ReactNode; onClick: () => void; active: boolean; dir: "asc" | "desc"; right?: boolean;
}) {
  return (
    <th className={`px-3 py-2.5 font-medium ${right ? "text-right" : ""}`}>
      <button onClick={onClick} className={`inline-flex items-center gap-1 hover:text-slate-900 ${active ? "text-slate-900" : ""}`}>
        {children}
        <span className="text-[9px]">{active ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

function RepRow({
  row, period, isOpen, onToggle,
}: {
  row: Row; period: PeriodKey; isOpen: boolean; onToggle: () => void;
}) {
  const m = row.m;
  const connPct = m.calls.connect_rate;
  const dim = row.activity === 0;
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-slate-100 transition hover:bg-blue-50/50 ${dim ? "opacity-50" : ""} ${isOpen ? "bg-blue-50/60" : ""}`}
      >
        <td className="px-3 py-2.5 font-medium text-slate-800">
          <span className="mr-2 text-slate-400">{isOpen ? "▾" : "▸"}</span>
          {row.name}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums">{fmt(m.unique_contacts)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">{fmt(m.unique_companies)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">{m.avg_contacts_per_company.toFixed(1)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">{fmt(m.calls.total)}</td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-rose-200">
              <div className="h-full bg-emerald-500" style={{ width: `${Math.round(connPct * 100)}%` }} />
            </div>
            <span className="tabular-nums text-xs text-slate-500">{pct(connPct)}</span>
          </div>
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums">{fmt(m.emails.sent)}</td>
        <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">{fmt(row.activity)}</td>
      </tr>
      {isOpen && (
        <tr className="border-b border-slate-200 bg-slate-50/70">
          <td colSpan={8} className="px-4 py-5">
            <RepPanel data={row.data} m={m} period={period} name={row.name} />
          </td>
        </tr>
      )}
    </>
  );
}

function RepPanel({
  data, m, period, name,
}: {
  data: RepData; m: PeriodMetrics; period: PeriodKey; name: string;
}) {
  return (
    <div className="space-y-5">
      <DailyChart daily={data.daily} name={name} />

      <div className="grid gap-5 lg:grid-cols-3">
        <DispositionBars m={m} />
        <ChannelMix m={m} />
        <CompanyList m={m} period={period} />
      </div>
    </div>
  );
}

function DailyChart({ daily, name }: { daily: DailyPoint[]; name: string }) {
  if (!daily?.length) return null;
  const max = Math.max(1, ...daily.map((d) => d.calls + d.emails));
  const H = 96;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Daily activity — {name} (this month)
        </h3>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          <Legend color="bg-emerald-500" label="Connected calls" />
          <Legend color="bg-blue-400" label="Other calls" />
          <Legend color="bg-indigo-300" label="Emails" />
        </div>
      </div>
      <div className="flex items-end gap-[3px]" style={{ height: H }}>
        {daily.map((d) => {
          const total = d.calls + d.emails;
          const others = Math.max(0, d.calls - d.connected);
          const seg = (v: number) => (total ? Math.round((v / max) * H) : 0);
          const title = `${d.date}\nCalls: ${d.calls} (connected ${d.connected})\nEmails: ${d.emails}`;
          return (
            <div key={d.date} title={title} className="flex flex-1 flex-col justify-end" style={{ minWidth: 4 }}>
              <div className="bg-indigo-300" style={{ height: seg(d.emails) }} />
              <div className="bg-blue-400" style={{ height: seg(others) }} />
              <div className="rounded-t-sm bg-emerald-500" style={{ height: seg(d.connected) }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{daily[0]?.date.slice(5)}</span>
        <span>{daily[Math.floor(daily.length / 2)]?.date.slice(5)}</span>
        <span>{daily[daily.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2 w-2 rounded-sm ${color}`} />
      {label}
    </span>
  );
}

function DispositionBars({ m }: { m: PeriodMetrics }) {
  const entries = Object.entries(m.calls.by_disposition);
  const max = Math.max(1, ...entries.map(([, c]) => c));
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Calls by outcome</h3>
      <div className="mb-3 text-xs text-slate-500">
        {fmt(m.calls.connected)} connected · {fmt(m.calls.not_connected)} not · {pct(m.calls.connect_rate)} rate
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-slate-400">No calls in this period.</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map(([label, count]) => {
            const connected = CONNECTED_LABELS.has(label);
            return (
              <li key={label} className="text-xs">
                <div className="flex items-center justify-between">
                  <span className="truncate pr-2 text-slate-600">{label}</span>
                  <span className="tabular-nums text-slate-500">{fmt(count)}</span>
                </div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div className={connected ? "h-full bg-emerald-500" : "h-full bg-rose-400"} style={{ width: `${(count / max) * 100}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ChannelMix({ m }: { m: PeriodMetrics }) {
  const { call_only, email_only, both } = m.channel_mix;
  const total = Math.max(1, call_only + email_only + both);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Channel mix &amp; email</h3>
      <div className="mb-2 flex h-3 overflow-hidden rounded-full">
        <div className="bg-blue-400" style={{ width: `${(call_only / total) * 100}%` }} title={`Call only: ${call_only}`} />
        <div className="bg-emerald-500" style={{ width: `${(both / total) * 100}%` }} title={`Both: ${both}`} />
        <div className="bg-indigo-300" style={{ width: `${(email_only / total) * 100}%` }} title={`Email only: ${email_only}`} />
      </div>
      <ul className="space-y-1 text-xs text-slate-600">
        <li className="flex justify-between"><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-blue-400" />Call only</span><span className="tabular-nums">{fmt(call_only)}</span></li>
        <li className="flex justify-between"><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500" />Both channels</span><span className="tabular-nums">{fmt(both)}</span></li>
        <li className="flex justify-between"><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-indigo-300" />Email only</span><span className="tabular-nums">{fmt(email_only)}</span></li>
        <li className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-slate-600">
          <span>Emails bounced</span>
          <span className="tabular-nums text-rose-500">{fmt(m.emails.bounced)} ({pct(m.emails.bounce_rate)})</span>
        </li>
        {m.unattributed_activities > 0 && (
          <li className="flex justify-between text-slate-400"><span>Unattributed</span><span className="tabular-nums">{fmt(m.unattributed_activities)}</span></li>
        )}
      </ul>
    </div>
  );
}

function CompanyList({ m, period }: { m: PeriodMetrics; period: PeriodKey }) {
  const [openCo, setOpenCo] = useState<string | null>(null);
  const hasBreakdown = NARROW_PERIODS.includes(period);
  const breakdown = m.company_breakdown ?? [];

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Companies tapped {hasBreakdown ? `(${breakdown.length})` : ""}
        <span className="ml-1 font-normal normal-case text-slate-400">→ HubSpot</span>
      </h3>
      {!hasBreakdown ? (
        <p className="text-sm text-slate-400">Per-company detail available for Today / Yesterday / This week.</p>
      ) : breakdown.length === 0 ? (
        <p className="text-sm text-slate-400">No companies tapped in this period.</p>
      ) : (
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {breakdown.map((c) => {
            const open = openCo === c.id;
            const contacts = c.contacts_list ?? [];
            return (
              <div key={c.id} className="rounded-md border border-slate-100">
                <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
                  <button
                    onClick={() => setOpenCo(open ? null : c.id)}
                    className="flex min-w-0 items-center gap-1.5 text-left"
                    disabled={contacts.length === 0}
                  >
                    {contacts.length > 0 && <span className="text-slate-400">{open ? "▾" : "▸"}</span>}
                    <span className="truncate text-slate-700">{c.name}</span>
                  </button>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                    <span className="tabular-nums" title="contacts / calls / emails">
                      {fmt(c.contacts)}c · {fmt(c.calls)}☎ · {fmt(c.emails)}✉
                    </span>
                    <a
                      href={companyUrl(c.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-600 hover:bg-blue-100"
                      title="Open company in HubSpot"
                    >
                      ↗
                    </a>
                  </div>
                </div>
                {open && contacts.length > 0 && (
                  <ul className="border-t border-slate-100 px-2 py-1.5 text-xs">
                    {contacts.map((ct) => (
                      <li key={ct.id} className="flex items-center justify-between py-0.5">
                        <span className="truncate pr-2 text-slate-600">{ct.name}</span>
                        <a
                          href={contactUrl(ct.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-blue-600 hover:underline"
                          title="Open contact in HubSpot"
                        >
                          ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
