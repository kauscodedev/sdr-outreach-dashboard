/**
 * Intelligence 2.0 shared shapes — Ask-TrackerAI (RAG Q&A), the signals engine, and the
 * Focus/Radar/Themes read models. Pure types: imported by both server code and client
 * components (no server-only dependencies here).
 */
import { DealHealth } from "../sync/deal-health";

// ── Ask-TrackerAI ────────────────────────────────────────────────────────────────────

export interface AskFilters {
  ownerIds?: string[] | null; // explicit rep filter (activity doers)
  accountId?: string | null;
  kind?: "call" | "email" | null;
  afterMs?: number | null;
  beforeMs?: number | null;
}

export interface AskRequest {
  question: string; // ≤500 chars
  scope?: "mine" | "all"; // default "mine" → viewer.defaultOwnerIds (focus model, not security)
  filters?: AskFilters;
}

/** One evidence source behind an [S#] marker in the answer. The server expands tags to full
 *  citations — the model never reproduces activity ids (it would mangle them). */
export interface AskCitation {
  tag: string; // "S3" — matches [S3] markers in the answer markdown
  hs_id: string; // activity id → timeline drawer / HubSpot callUrl
  account_id: string | null;
  account_name: string | null;
  ts_ms: number | null;
  kind: string | null;
  excerpt: string; // first ~200 chars of the matched chunk
}

export interface AskResponse {
  answer: string; // markdown with [S#] markers
  citations: AskCitation[];
  accounts: { id: string; name: string | null }[]; // distinct cited accounts → drawer chips
  searches: number;
  steps: number;
  ms: number;
  model: string;
}

// ── Signals engine ───────────────────────────────────────────────────────────────────

export const SIGNAL_LABELS = [
  "objection",
  "competitor_mention",
  "pricing_question",
  "buying_signal",
  "risk_phrase",
  "commitment",
  "timing",
] as const;
export type SignalLabel = (typeof SIGNAL_LABELS)[number];

export const OBJECTION_CATEGORIES = [
  "price", "budget", "timing", "authority", "competitor", "product_fit", "trust", "no_need", "other",
] as const;
export type ObjectionCategory = (typeof OBJECTION_CATEGORIES)[number];

export const SIGNAL_LABEL_META: Record<SignalLabel, { label: string; tone: "warn" | "good" | "danger" | "neutral" }> = {
  objection: { label: "Objection", tone: "warn" },
  competitor_mention: { label: "Competitor", tone: "danger" },
  pricing_question: { label: "Pricing question", tone: "neutral" },
  buying_signal: { label: "Buying signal", tone: "good" },
  risk_phrase: { label: "Risk", tone: "danger" },
  commitment: { label: "Commitment", tone: "good" },
  timing: { label: "Timing", tone: "neutral" },
};

/** One mined signal (a sdr_intel_signals row, camelCase). */
export interface IntelSignal {
  hsId: string;
  accountId: string | null;
  ownerId: string | null;
  tsMs: number | null;
  kind: string | null;
  label: SignalLabel;
  category: string | null;
  quote: string;
  confidence: number | null;
}

// ── Themes (manager view) ────────────────────────────────────────────────────────────

export interface ThemeRow {
  label: SignalLabel;
  category: string;
  mentions: number;
  accounts: number;
  reps: number;
}

export interface ThemeTrendPoint {
  week_start: string; // YYYY-MM-DD (ET Monday)
  category: string;
  mentions: number;
}

export interface ThemeExample {
  label: SignalLabel;
  category: string | null;
  quote: string;
  accountId: string | null;
  accountName: string | null;
  tsMs: number | null;
}

export interface ThemesResponse {
  from: string;
  to: string;
  themes: ThemeRow[];
  trend: ThemeTrendPoint[]; // for the selected label
  trendLabel: SignalLabel;
  examples: ThemeExample[];
}

// ── SDR Daily Focus ──────────────────────────────────────────────────────────────────

export type FocusBucket = "watch" | "at_risk_demo" | "revive";

export interface FocusItem {
  accountId: string;
  accountName: string;
  bucket: FocusBucket;
  why: string; // watch.reason | deal.health_reason | "replied Jun 30, quiet 19d"
  nextStep: string | null; // from the watch when present
  priority: "high" | "medium" | "low";
  lastMs: number | null;
  signals: { label: SignalLabel; quote: string; tsMs: number | null }[];
  actionStatus: "not_started" | "in_progress" | "completed" | "snoozed";
}

export interface FocusResponse {
  repId: string;
  repName: string | null;
  items: FocusItem[];
}

// ── AE Deal Radar ────────────────────────────────────────────────────────────────────

export interface RadarSignal {
  label: SignalLabel;
  category: string | null;
  quote: string;
  tsMs: number | null;
}

export interface RadarDeal {
  dealId: string;
  accountId: string | null;
  accountName: string | null;
  stageKey: string;
  stageLabel: string;
  amount: number | null;
  aeId: string | null;
  sdrId: string | null;
  daysInStage: number | null;
  stale: boolean; // >14d in current stage (matches the Deal Health yellow ladder)
  lastActivityMs: number | null; // account-level; >90d quiet = "zombie", sunk below actionables
  health: DealHealth | null;
  healthReason: string | null;
  riskSignals: RadarSignal[]; // objection / risk_phrase / competitor_mention, ≤21d
}

export interface RadarResponse {
  deals: RadarDeal[];
}

// ── Shared action tracking (sdr_agent_actions) ──────────────────────────────────────

export type ActionStatus = "not_started" | "in_progress" | "completed" | "snoozed";
export type ActionType = "call" | "email" | "meeting" | "note" | "snoozed";

export interface SharedAction {
  accountId: string;
  status: ActionStatus;
  lastActionType: ActionType | null;
  lastActionAt: string | null; // ISO
  snoozedUntil: string | null; // ISO
  notes: { at: string; by: string | null; note: string }[];
  updatedBy: string | null;
}
