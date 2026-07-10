/**
 * Deal Health — the "demo → closure" indicator for accounts that HAVE a live deal (the AE world).
 * Distinct from Temperature (the "lead → demo" indicator for pre-deal accounts). Never merged:
 * an account deep In Discussion isn't "hot" in the cold-outreach sense — it's a healthy deal.
 *
 * Precedence ladder (first match wins). Terminal states short-circuit BEFORE recency, so a freshly
 * touched dropped deal is still Red and a quiet won deal is still Green — stage identity dominates,
 * recency only arbitrates among genuinely-active deals.
 *
 * Thresholds locked with the user:
 *   • a LIVE active deal untouched 14d → Yellow, 30d → Red
 *   • a Demo-Scheduled deal whose demo date has passed with no stage advance → Yellow immediately
 */
import { DealStageKey, stageLabel, isWon, isLost, isMeetingSet } from "../../config/deal-stages";

export type DealHealth = "green" | "yellow" | "red";

export interface DealHealthInput {
  stageKey: DealStageKey;
  demoScheduledForMs: number | null; // the booked demo date (demo_scheduled_for_date)
  lastActivityMs: number | null; // most recent touch on the account
  nowMs: number;
}

export interface DealHealthResult {
  health: DealHealth;
  reason: string;
}

const DAY_MS = 86_400_000;
const YELLOW_DAYS = 14;
const RED_DAYS = 30;

/** Recency ladder for genuinely-active deals: fresh → Green, 14–30d → Yellow, 30d+ → Red. */
function byRecency(lastActivityMs: number | null, nowMs: number): DealHealthResult {
  if (lastActivityMs == null) return { health: "yellow", reason: "No recent activity logged" };
  const days = Math.floor((nowMs - lastActivityMs) / DAY_MS);
  if (days >= RED_DAYS) return { health: "red", reason: `No activity in ${days}d` };
  if (days >= YELLOW_DAYS) return { health: "yellow", reason: `Quiet — ${days}d since last touch` };
  return { health: "green", reason: days <= 0 ? "Active — touched today" : `Active — touched ${days}d ago` };
}

export function classifyDealHealth(i: DealHealthInput): DealHealthResult {
  const { stageKey, demoScheduledForMs, lastActivityMs, nowMs } = i;

  // Terminal states — decide on stage alone.
  if (isLost(stageKey)) return { health: "red", reason: stageLabel(stageKey) };
  if (isWon(stageKey)) return { health: "green", reason: "Won" };
  if (stageKey === "future_prospect") return { health: "yellow", reason: "Future prospect — parked" };

  // Meeting-set stages (demo booked, not yet conducted).
  if (isMeetingSet(stageKey)) {
    if (stageKey === "demo_no_show") return { health: "yellow", reason: "Demo no-show — reschedule" };
    if (stageKey === "demo_rescheduled") return { health: "yellow", reason: "Demo rescheduled" };
    // discovery_done: judge by the demo date, else fall through to recency.
    if (demoScheduledForMs != null && demoScheduledForMs < nowMs) {
      return { health: "yellow", reason: "Demo date passed — follow up" };
    }
    if (demoScheduledForMs != null && demoScheduledForMs >= nowMs) {
      const day = new Date(demoScheduledForMs).toISOString().slice(0, 10);
      return { health: "green", reason: `Demo scheduled ${day}` };
    }
  }

  // Everything else that's live (demo done → contract initiated, plus discovery with no date, mql):
  // health is driven by how recently the account was touched.
  return byRecency(lastActivityMs, nowMs);
}
