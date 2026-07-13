/**
 * Data-integrity checks (blueprint §7.5, read-only v1) — pure, over deals + their stage-event
 * ledgers + a company lookup. Each finding carries a deterministic suggested action; AI-assisted
 * resolution and HubSpot write-back come later (P4). Checks run on ACTIVE deals (a lost orphan
 * is history, not a task) except stage_regression, which audits the ledger itself.
 */
import { Deal } from "../sync/types";
import { DealStageKey, isActive, isMeetingSet, stageLabel, stageOrder } from "../../config/deal-stages";

export type IntegrityKind =
  | "orphan_deal" // no company association → invisible to account funnel/health
  | "slipped_demo" // demo date passed but the deal still sits in a meeting-set stage
  | "stale_active" // active deal with no stage movement for 30d+
  | "owner_mismatch" // deal's SDR owner ≠ the account's owner
  | "stage_regression"; // ledger shows the deal moved BACKWARD through the funnel

export interface IntegrityItem {
  kind: IntegrityKind;
  severity: "high" | "medium";
  deal_id: string;
  company_id: string | null;
  company_name: string | null;
  owner_id: string | null; // the rep responsible (SDR owner, else AE)
  detail: string;
  suggestion: string;
  ms: number | null; // the relevant timestamp (sorting/recency)
}

export interface CompanyRef {
  name: string | null;
  owner_id: string | null;
}

const DAY_MS = 86_400_000;
export const STALE_DAYS = 30;
export const STALE_HIGH_DAYS = 60;

/** When the deal entered its current stage (latest matching ledger entry). */
function enteredCurrentMs(d: Deal): number | null {
  let ms: number | null = null;
  for (const e of d.stageEvents ?? []) {
    if (e.stageKey === d.stageKey && (ms == null || e.enteredMs > ms)) ms = e.enteredMs;
  }
  return ms;
}

export function runIntegrityChecks(
  deals: Deal[],
  companies: Map<string, CompanyRef>,
  nowMs: number,
): IntegrityItem[] {
  const items: IntegrityItem[] = [];
  const co = (d: Deal) => (d.companyId ? companies.get(d.companyId) : undefined);
  const base = (d: Deal) => ({
    deal_id: d.id,
    company_id: d.companyId,
    company_name: co(d)?.name ?? null,
    owner_id: d.sdrOwnerId ?? d.dealOwnerId ?? null,
  });

  for (const d of deals) {
    const active = isActive(d.stageKey);

    // 1. Orphan: no company → excluded from demo-status, funnel, health, coverage.
    if (active && !d.companyId) {
      const hasContacts = d.contactIds.length > 0;
      items.push({
        kind: "orphan_deal", severity: "high", ...base(d),
        detail: `Active deal at ${stageLabel(d.stageKey)} has no company association — invisible to the account funnel and Deal Health.`,
        suggestion: hasContacts
          ? "Associate the contact's company on the deal in HubSpot (the contact has no company either — fix both)."
          : "Deal has no contacts either — associate a company and a contact in HubSpot.",
        ms: enteredCurrentMs(d),
      });
    }

    // 2. Slipped demo: meeting-set stage but the demo date is in the past.
    if (active && isMeetingSet(d.stageKey) && d.demoScheduledForMs != null && d.demoScheduledForMs < nowMs - DAY_MS) {
      const daysAgo = Math.floor((nowMs - d.demoScheduledForMs) / DAY_MS);
      items.push({
        kind: "slipped_demo", severity: daysAgo > 7 ? "high" : "medium", ...base(d),
        detail: `Demo was scheduled ${daysAgo}d ago but the deal still sits at ${stageLabel(d.stageKey)}.`,
        suggestion: "Reschedule the demo or advance/close the stage in HubSpot.",
        ms: d.demoScheduledForMs,
      });
    }

    // 3. Stale active: no stage movement for STALE_DAYS+.
    if (active) {
      const entered = enteredCurrentMs(d);
      if (entered != null) {
        const days = Math.floor((nowMs - entered) / DAY_MS);
        if (days >= STALE_DAYS) {
          items.push({
            kind: "stale_active", severity: days >= STALE_HIGH_DAYS ? "high" : "medium", ...base(d),
            detail: `${days}d at ${stageLabel(d.stageKey)} with no stage movement.`,
            suggestion: "Review with the owner — advance, park as Future Prospect, or drop.",
            ms: entered,
          });
        }
      }
    }

    // 4. Owner mismatch: the deal credits one SDR, the account is owned by someone else.
    if (active && d.sdrOwnerId && d.companyId) {
      const accOwner = co(d)?.owner_id;
      if (accOwner && accOwner !== d.sdrOwnerId && accOwner !== d.dealOwnerId) {
        items.push({
          kind: "owner_mismatch", severity: "medium", ...base(d),
          detail: "The deal's SDR owner is not the account's owner — funnel credit and book coverage disagree.",
          suggestion: "Align the deal's sdr_owner or the account's owner in HubSpot.",
          ms: enteredCurrentMs(d),
        });
      }
    }

    // 5. Stage regression: the ledger shows a move BACKWARD through live funnel stages.
    const ev = (d.stageEvents ?? []).filter((e) => stageOrder(e.stageKey) > 0);
    let maxOrder = 0;
    let maxKey: DealStageKey | null = null;
    for (const e of ev) {
      const o = stageOrder(e.stageKey);
      if (o < maxOrder && maxKey) {
        items.push({
          kind: "stage_regression", severity: "medium", ...base(d),
          detail: `Moved backward: ${stageLabel(maxKey)} → ${stageLabel(e.stageKey)}.`,
          suggestion: "Verify the stage change was intentional (misclick or a reopened deal?).",
          ms: e.enteredMs,
        });
        break; // one finding per deal
      }
      if (o > maxOrder) { maxOrder = o; maxKey = e.stageKey; }
    }
  }

  // Severity first, then recency (newest signal first).
  return items.sort((a, b) =>
    a.severity === b.severity ? (b.ms ?? 0) - (a.ms ?? 0) : a.severity === "high" ? -1 : 1);
}
