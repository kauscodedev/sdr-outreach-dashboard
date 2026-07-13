"use client";

/**
 * GD Book Explorer (Phase 3): the rep's owned Group-Dealership / Single units rendered as a
 * nested table — Units → Rooftops → Contacts — via the shared AccountsTable primitives.
 * Numbers reconcile with BookCoverage by construction. Unit detail is lazy-loaded from
 * /api/rep/[ownerId]/book (stripped from the page payload for size).
 */
import { useEffect, useMemo, useState } from "react";
import {
  BookCoverage, BookUnitDetail, STAGE_GROUPS, MARKET_SEGMENTS, MARKET_SEGMENT_LABELS, MarketSegment,
} from "../lib/sync/types";
import { Surface, SectionTitle, cn } from "./ui";
import { UnitsTable } from "./AccountsTable";

const fmt = (n: number) => n.toLocaleString("en-IN");

type Filter = "all" | "gds" | "singles" | "worked_by_other" | "untapped";

const selectCls = "rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink-muted outline-none focus:ring-2 focus:ring-primary/30";

export default function GdExplorer({ ownerId, book }: { ownerId: string; book: BookCoverage }) {
  const [units, setUnits] = useState<BookUnitDetail[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  // Column filters (V3): unit-level stage / segment / temperature.
  const [stage, setStage] = useState<string>("all");
  const [segment, setSegment] = useState<string>("all");
  const [temp, setTemp] = useState<string>("all");

  useEffect(() => {
    let live = true;
    fetch(`/api/rep/${ownerId}/book`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => live && setUnits(d.units ?? []))
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [ownerId]);

  const shown = useMemo(() => {
    let all = units ?? [];
    if (filter === "gds") all = all.filter((u) => u.isGroup);
    else if (filter === "singles") all = all.filter((u) => !u.isGroup);
    else if (filter === "worked_by_other") all = all.filter((u) => u.coverage === "worked_by_other");
    else if (filter === "untapped") all = all.filter((u) => u.coverage === "untapped");
    if (stage !== "all") all = all.filter((u) => u.stage === stage);
    if (segment !== "all") all = all.filter((u) => u.segment === segment);
    if (temp !== "all") all = all.filter((u) => u.temp === temp);
    return all;
  }, [units, filter, stage, segment, temp]);

  const filtersActive = stage !== "all" || segment !== "all" || temp !== "all";

  // Coverage is a 3-way split on the 60-day owner window: tapped / worked-by-others / untapped.
  const untapped = Math.max(0, book.units_total - book.units_tapped - book.units_worked_by_other);
  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: `All ${fmt(book.units_total)}` },
    { key: "gds", label: `GDs ${fmt(book.gds)}` },
    { key: "singles", label: `Singles ${fmt(book.singles)}` },
    { key: "worked_by_other", label: `Worked by others ${fmt(book.units_worked_by_other)}` },
    { key: "untapped", label: `Untapped ${fmt(untapped)}` },
  ];

  return (
    <Surface className="p-4">
      <SectionTitle right={<span className="text-[11px] tabular-nums text-ink-subtle">{fmt(book.rooftops_total)} rooftops · {fmt(book.units_tapped)}/{fmt(book.units_total)} tapped</span>}>
        Book Explorer — Group → Rooftops → Contacts
      </SectionTitle>

      <div className="mb-2 mt-3 flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setFilter(t.key)}
            className={cn("rounded-lg px-2.5 py-1 text-xs font-semibold transition", filter === t.key ? "bg-ink text-white" : "bg-surface-muted text-ink-muted hover:text-ink")}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <select value={stage} onChange={(e) => setStage(e.target.value)} className={selectCls} aria-label="Filter by stage">
          <option value="all">Stage: all</option>
          {STAGE_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={segment} onChange={(e) => setSegment(e.target.value)} className={selectCls} aria-label="Filter by segment">
          <option value="all">Segment: all</option>
          {MARKET_SEGMENTS.map((s) => <option key={s} value={s}>{MARKET_SEGMENT_LABELS[s as MarketSegment]}</option>)}
        </select>
        <select value={temp} onChange={(e) => setTemp(e.target.value)} className={selectCls} aria-label="Filter by temperature">
          <option value="all">Temp: all</option>
          <option value="hot">Hot</option>
          <option value="warm">Warm</option>
          <option value="cold">Cold</option>
        </select>
        {filtersActive && (
          <button onClick={() => { setStage("all"); setSegment("all"); setTemp("all"); }}
            className="rounded-lg bg-surface-muted px-2 py-1 text-xs font-semibold text-ink-muted transition hover:text-ink">
            Clear · {fmt(shown.length)} shown
          </button>
        )}
      </div>

      {failed ? <p className="text-sm text-ink-subtle">Book detail unavailable.</p>
      : units === null ? <p className="text-sm text-ink-subtle">Loading book…</p>
      : <div className="max-h-[30rem] overflow-y-auto scroll-y"><UnitsTable units={shown} /></div>}
    </Surface>
  );
}
