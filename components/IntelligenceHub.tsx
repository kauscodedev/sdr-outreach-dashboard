"use client";

/**
 * The Intelligence hub (/attention) — one tabbed surface for the whole AI layer:
 *   Ask     · on-demand RAG Q&A with citations (everyone)
 *   Focus   · the SDR's daily list (watches + at-risk demos + revivals)
 *   Radar   · the AE's risk-ranked live pipeline
 *   Themes  · the manager view of what prospects keep saying
 *   Board   · the original hot-account watch board (kanban/list + briefs)
 * The default tab is role-aware (SDR → Focus, AE → Radar, managers → Ask); ?tab= deep-links.
 */
import { useState } from "react";
import { Sparkles, ListTodo, Radar, BarChart3, Flame } from "lucide-react";
import { AgentBrief, AgentWatch } from "../lib/agent/types";
import AskPanel from "./AskPanel";
import FocusList from "./FocusList";
import DealRadar from "./DealRadar";
import ThemesView from "./ThemesView";
import AttentionBoardEnhanced from "./AttentionBoardEnhanced";
import { cn } from "./ui";

export type IntelTab = "ask" | "focus" | "radar" | "themes" | "board";

const TABS: { key: IntelTab; label: string; icon: typeof Sparkles; hint: string }[] = [
  { key: "ask", label: "Ask", icon: Sparkles, hint: "Ask anything — answers cite your calls & emails" },
  { key: "focus", label: "Focus", icon: ListTodo, hint: "The SDR daily list: hot, at-risk, revivable" },
  { key: "radar", label: "Radar", icon: Radar, hint: "Live deals ranked by voiced risk + staleness" },
  { key: "themes", label: "Themes", icon: BarChart3, hint: "Objections, competitors & buying signals, mined nightly" },
  { key: "board", label: "Board", icon: Flame, hint: "The hot-account watch board" },
];

export default function IntelligenceHub({ defaultTab, scoped, names, repOptions, defaultRep, watches, briefs }: {
  defaultTab: IntelTab;
  scoped: boolean;
  names: Record<string, string>;
  repOptions: { id: string; name: string }[];
  defaultRep: string | null;
  watches: AgentWatch[];
  briefs: Record<string, AgentBrief>;
}) {
  const [tab, setTab] = useState<IntelTab>(defaultTab);
  // Mount tabs lazily but keep them alive once visited (filters/answers survive tab hops).
  const [visited, setVisited] = useState<Record<string, boolean>>({ [defaultTab]: true });

  const pick = (t: IntelTab) => {
    setTab(t);
    setVisited((v) => ({ ...v, [t]: true }));
    try { window.history.replaceState(null, "", `/attention?tab=${t}`); } catch { /* SSR-safe */ }
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap gap-1.5">
        {TABS.map(({ key, label, icon: Icon, hint }) => (
          <button key={key} onClick={() => pick(key)} title={hint}
            className={cn("inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold transition",
              tab === key ? "bg-primary text-primary-fg shadow-card" : "bg-surface text-ink-muted shadow-card hover:text-ink")}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      <div className={tab === "ask" ? "" : "hidden"}>{visited.ask && <AskPanel scoped={scoped} />}</div>
      <div className={tab === "focus" ? "" : "hidden"}>{visited.focus && <FocusList repOptions={repOptions} defaultRep={defaultRep} />}</div>
      <div className={tab === "radar" ? "" : "hidden"}>{visited.radar && <DealRadar scoped={scoped} names={names} />}</div>
      <div className={tab === "themes" ? "" : "hidden"}>{visited.themes && <ThemesView scoped={scoped} />}</div>
      <div className={tab === "board" ? "" : "hidden"}>{visited.board && <AttentionBoardEnhanced watches={watches} names={names} briefs={briefs} />}</div>
    </div>
  );
}
