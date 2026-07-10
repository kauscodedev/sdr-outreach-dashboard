/**
 * SDR demo-status segmentation — pure, over a company's canonical deal-stage keys.
 *
 * The SDR world is "lead → demo". Every owned company falls into exactly one bucket:
 *   • demo_pending   — the real target list: no LIVE deal has reached Discovery Call Done. That's
 *                      "no deal", "only an MQL deal", or "only dead deals" (dropped / Non SAL).
 *                      Dead-only accounts are flagged `hasRevivable` so the SDR can re-work them.
 *   • demo_scheduled — a live deal is at Discovery Call Done / No-Show / Rescheduled: the meeting is
 *                      booked but the demo hasn't been conducted. No-show/reschedule sets `atRisk`.
 *   • demo_done      — a live deal has reached Demo Done or beyond (the AE's demo→closure motion).
 *
 * When a company has several deals, the FURTHEST live one governs (stageOrder). Dead deals never
 * govern — a single live opportunity always outranks any number of dropped ones.
 */
import { DealStageKey, isMeetingSet, isPostDemo, isLost, stageOrder } from "../../config/deal-stages";

export type DemoStatus = "demo_pending" | "demo_scheduled" | "demo_done";

export interface AccountDealSummary {
  status: DemoStatus;
  furthestStageKey: DealStageKey | null; // furthest LIVE stage (null if no live deal)
  hasRevivable: boolean; // only dead deals exist — previously worked, re-workable
  atRisk: boolean; // scheduled but the demo bounced (no-show / rescheduled)
}

export function segmentAccount(stageKeys: DealStageKey[]): AccountDealSummary {
  const live = stageKeys.filter((k) => !isLost(k) && k !== "other");
  const hasDead = stageKeys.some((k) => isLost(k));

  const advanced = live.filter((k) => isMeetingSet(k) || isPostDemo(k));
  if (advanced.length === 0) {
    // No live deal past discovery → still the SDR's to work.
    const furthestLive = live.length ? live.reduce(furthest) : null;
    return { status: "demo_pending", furthestStageKey: furthestLive, hasRevivable: hasDead, atRisk: false };
  }

  const furthestAdvanced = advanced.reduce(furthest);
  if (isPostDemo(furthestAdvanced)) {
    return { status: "demo_done", furthestStageKey: furthestAdvanced, hasRevivable: false, atRisk: false };
  }
  const atRisk = advanced.some((k) => k === "demo_no_show" || k === "demo_rescheduled");
  return { status: "demo_scheduled", furthestStageKey: furthestAdvanced, hasRevivable: false, atRisk };
}

const furthest = (a: DealStageKey, b: DealStageKey): DealStageKey => (stageOrder(b) > stageOrder(a) ? b : a);
