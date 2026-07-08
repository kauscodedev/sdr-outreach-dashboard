"use client";

/**
 * GD Book Explorer (Phase 3): the rep's owned Group-Dealership / Single units rendered as a
 * nested table — Units → Rooftops → Contacts — via the shared AccountsTable primitives.
 * Numbers reconcile with BookCoverage by construction. Unit detail is lazy-loaded from
 * /api/rep/[ownerId]/book (stripped from the page payload for size).
 */
import { useEffect, useMemo, useState } from "react";
import { BookCoverage, BookUnitDetail } from "../lib/sync/types";
import { Surface, SectionTitle, cn } from "./ui";
import { UnitsTable } from "./AccountsTable";

const fmt = (n: number) => n.toLocaleString("en-IN");

type Filter = "all" | "gds" | "singles" | "untapped";

export default function GdExplorer({ ownerId, book }: { ownerId: string; book: BookCoverage }) {
  const [units, setUnits] = useState<BookUnitDetail[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let live = true;
    fetch(`/api/rep/${ownerId}/book`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => live && setUnits(d.units ?? []))
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [ownerId]);

  const shown = useMemo(() => {
    const all = units ?? [];
    if (filter === "gds") return all.filter((u) => u.isGroup);
    if (filter === "singles") return all.filter((u) => !u.isGroup);
    if (filter === "untapped") return all.filter((u) => !u.tapped);
    return all;
  }, [units, filter]);

  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: `All ${fmt(book.units_total)}` },
    { key: "gds", label: `GDs ${fmt(book.gds)}` },
    { key: "singles", label: `Singles ${fmt(book.singles)}` },
    { key: "untapped", label: `Untapped ${fmt(Math.max(0, book.units_total - book.units_tapped))}` },
  ];

  return (
    <Surface className="p-4">
      <SectionTitle right={<span className="text-[11px] tabular-nums text-ink-subtle">{fmt(book.rooftops_total)} rooftops · {fmt(book.units_tapped)}/{fmt(book.units_total)} tapped</span>}>
        Book Explorer — Group → Rooftops → Contacts
      </SectionTitle>

      <div className="mb-3 mt-3 flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setFilter(t.key)}
            className={cn("rounded-lg px-2.5 py-1 text-xs font-semibold transition", filter === t.key ? "bg-ink text-white" : "bg-surface-muted text-ink-muted hover:text-ink")}>
            {t.label}
          </button>
        ))}
      </div>

      {failed ? <p className="text-sm text-ink-subtle">Book detail unavailable.</p>
      : units === null ? <p className="text-sm text-ink-subtle">Loading book…</p>
      : <div className="max-h-[30rem] overflow-y-auto scroll-y"><UnitsTable units={shown} /></div>}
    </Surface>
  );
}
