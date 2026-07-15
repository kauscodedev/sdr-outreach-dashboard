import { BrainCircuit } from "lucide-react";
import { listWatches } from "../../lib/agent/store";
import { listBriefs } from "../../lib/agent/briefs";
import { resolveViewer } from "../../lib/access/resolve";
import { loadTeamStructure } from "../../lib/team/load";
import { nameMap } from "../../lib/team/helpers";
import { supabaseServer } from "../../lib/supabase/server";
import IntelligenceHub, { IntelTab } from "../../components/IntelligenceHub";
import AppNav from "../../components/AppNav";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TAB_KEYS: IntelTab[] = ["ask", "focus", "radar", "themes", "board"];

/** The Intelligence hub: Ask · Focus · Radar · Themes · Board. Role-aware default tab
 *  (SDR → Focus, AE → Radar, managers/admins → Ask); ?tab= deep-links. */
export default async function IntelligencePage({ searchParams }: { searchParams?: { tab?: string } }) {
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  const [watches, briefs, viewer, ts] = await Promise.all([
    listWatches(),
    listBriefs(),
    resolveViewer(user?.email ?? ""),
    loadTeamStructure(),
  ]);
  const names = nameMap(ts);

  // Focus model: watches filtered to the viewer's default scope (Board tab).
  const scopeSet = new Set(viewer.defaultOwnerIds);
  const filteredWatches = watches.filter((w) => scopeSet.has(w.repId ?? ""));

  // A "scoped" viewer (strict subset of tracked reps) gets My/All toggles inside the tabs.
  const scoped = viewer.defaultOwnerIds.length > 0 && viewer.defaultOwnerIds.length < Object.keys(names).length;
  const focusIds = scoped ? viewer.defaultOwnerIds : Object.keys(names);
  const repOptions = focusIds
    .map((id) => ({ id, name: names[id] ?? `ID:${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const urlTab = TAB_KEYS.includes(searchParams?.tab as IntelTab) ? (searchParams!.tab as IntelTab) : null;
  const roleTab: IntelTab = viewer.kind === "ae" ? "radar" : viewer.role === "rep" ? "focus" : "ask";

  return (
    <>
      <AppNav active="attention" viewer={viewer} />
      <main className="mx-auto max-w-[1500px] px-4 py-7 sm:px-6">
        <header className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-primary-fg shadow-card">
            <BrainCircuit className="h-5 w-5" strokeWidth={2.4} />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-ink sm:text-[28px]">Intelligence</h1>
            <p className="mt-0.5 text-sm text-ink-muted">
              Ask anything, work your focus list, watch deal risk, and see what prospects keep saying —
              every claim cites its call/email evidence. Read-only on HubSpot.
            </p>
          </div>
        </header>
        <IntelligenceHub
          defaultTab={urlTab ?? roleTab}
          scoped={scoped}
          names={names}
          repOptions={repOptions}
          defaultRep={viewer.defaultOwnerIds.length === 1 ? viewer.defaultOwnerIds[0] : null}
          watches={filteredWatches}
          briefs={briefs}
        />
      </main>
    </>
  );
}
