/**
 * SDR Daily Focus — PURE builder (unit-tested; loaders live in the API route). Merges three
 * account streams into one per-rep "work this today" list:
 *   watch          — the agent's live hot-account verdicts (why + next step already grounded)
 *   at_risk_demo   — scheduled demos flagged at-risk by segmentation (no-show / slipped date)
 *   revive         — past positive signal (meeting/reply/high-intent), quiet 14–30 days, no
 *                    live advanced deal: the window where a warm thread is going cold but is
 *                    still realistically revivable
 * Dedupe precedence: watch > at_risk_demo > revive. Completed/snoozed (shared actions) sink.
 */
import { AgentWatch } from "../agent/types";
import { RooftopDetail } from "../sync/types";
import { FocusItem, FocusBucket, SignalLabel, ActionStatus } from "./types";

export const REVIVE_QUIET_MIN_MS = 14 * 86_400_000;
export const REVIVE_QUIET_MAX_MS = 30 * 86_400_000;

export interface FocusActionState {
  status: ActionStatus;
  snoozedUntil: string | null; // ISO
}

const BUCKET_ORDER: Record<FocusBucket, number> = { at_risk_demo: 0, watch: 1, revive: 2 };
const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

const etDay = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit" });

/** Is this rooftop a revival candidate right now? Exported for targeted tests. */
export function isReviveCandidate(r: RooftopDetail, nowMs: number): boolean {
  if (r.disqualified) return false;
  if (!r.last_ms) return false;
  const quiet = nowMs - r.last_ms;
  if (quiet < REVIVE_QUIET_MIN_MS || quiet > REVIVE_QUIET_MAX_MS) return false;
  const positive = r.meetings > 0 || r.replied > 0 || r.high_intent > 0;
  if (!positive) return false;
  // A live advanced deal means the account is already in motion — not a revival case.
  const d = r.deal;
  if (d && d.demo_status !== "demo_pending" && !d.has_revivable) return false;
  return true;
}

function reviveWhy(r: RooftopDetail, nowMs: number): string {
  const quietDays = Math.floor((nowMs - (r.last_ms ?? nowMs)) / 86_400_000);
  const signal = r.meetings > 0 ? "meeting-level intent" : r.high_intent > 0 ? "high-intent callback" : "email reply";
  return `Showed ${signal}, last touch ${r.last_ms ? etDay(r.last_ms) : "unknown"} — quiet ${quietDays}d`;
}

export function buildFocus(args: {
  watches: AgentWatch[]; // already scoped to this rep
  rooftops: RooftopDetail[]; // the rep's owned rooftops (units flattened)
  actions: Map<string, FocusActionState>;
  signalsByAccount: Map<string, { label: SignalLabel; quote: string; tsMs: number | null }[]>;
  nowMs: number;
}): FocusItem[] {
  const { watches, rooftops, actions, signalsByAccount, nowMs } = args;
  const items = new Map<string, FocusItem>();

  const actionStatus = (accountId: string): ActionStatus => {
    const a = actions.get(accountId);
    if (!a) return "not_started";
    if (a.status === "snoozed" && a.snoozedUntil && Date.parse(a.snoozedUntil) <= nowMs) return "not_started"; // snooze expired
    return a.status;
  };

  const put = (accountId: string, item: Omit<FocusItem, "signals" | "actionStatus">) => {
    if (items.has(accountId)) return; // precedence: first writer wins (callers order by precedence)
    items.set(accountId, {
      ...item,
      signals: (signalsByAccount.get(accountId) ?? []).slice(0, 2),
      actionStatus: actionStatus(accountId),
    });
  };

  // 1. Agent watches (highest precedence: they carry a grounded why + next step).
  for (const w of watches) {
    if (w.status !== "watching" && w.status !== "meeting_booked") continue;
    put(w.accountId, {
      accountId: w.accountId,
      accountName: w.accountName ?? w.accountId,
      bucket: "watch",
      why: w.reason ?? "Hot account",
      nextStep: w.nextStep,
      priority: w.priority ?? "medium",
      lastMs: w.lastSignalMs,
    });
  }

  // 2. At-risk scheduled demos (a booked demo slipping is the most expensive thing to ignore).
  for (const r of rooftops) {
    if (r.deal?.demo_status === "demo_scheduled" && r.deal.at_risk) {
      put(r.id, {
        accountId: r.id,
        accountName: r.name,
        bucket: "at_risk_demo",
        why: r.deal.health_reason ?? "Scheduled demo at risk — no-show or slipped date",
        nextStep: null,
        priority: "high",
        lastMs: r.last_ms,
      });
    }
  }

  // 3. Revival candidates.
  for (const r of rooftops) {
    if (isReviveCandidate(r, nowMs)) {
      put(r.id, {
        accountId: r.id,
        accountName: r.name,
        bucket: "revive",
        why: reviveWhy(r, nowMs),
        nextStep: null,
        priority: "medium",
        lastMs: r.last_ms,
      });
    }
  }

  return [...items.values()].sort((a, b) => {
    const doneA = a.actionStatus === "completed" || a.actionStatus === "snoozed" ? 1 : 0;
    const doneB = b.actionStatus === "completed" || b.actionStatus === "snoozed" ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;
    if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority]) return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (BUCKET_ORDER[a.bucket] !== BUCKET_ORDER[b.bucket]) return BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    return (b.lastMs ?? 0) - (a.lastMs ?? 0);
  });
}
