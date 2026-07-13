/**
 * Stage-event extraction — pure, over a deal's raw HubSpot properties.
 *
 * hs_v2_date_entered_<stageId> / hs_v2_date_exited_<stageId> are HubSpot-calculated per-stage
 * timestamps that exist automatically for every pipeline stage. They carry WHEN a deal (last)
 * entered/exited each stage and power the sdr_deal_stage_events ledger — the event-truth layer
 * under the period funnel metrics ("demos scheduled/completed in period P"), stage velocity,
 * and forecasting — without the property-history API.
 *
 * Kept out of pull.ts so tests can import it (pull.ts transitively imports server-only modules).
 */
import { AUTO_STAGE_BY_ID } from "../../config/deal-stages";
import { DealStageEvent } from "./types";

/** The extra deal properties the pull must request to build the ledger. */
export const STAGE_DATE_PROPERTIES = Object.keys(AUTO_STAGE_BY_ID).flatMap((id) => [
  `hs_v2_date_entered_${id}`,
  `hs_v2_date_exited_${id}`,
]);

/** Epoch-ms from a HubSpot datetime value (epoch-ms string or ISO), NaN if unparseable. */
function toMs(v: string | null | undefined): number {
  if (!v) return NaN;
  const n = Number(v);
  if (!Number.isNaN(n) && n > 0) return n;
  return new Date(v).getTime();
}

/** Extract the stage-event ledger from a deal's hs_v2 stage-date properties (entered_ms asc). */
export function stageEventsOf(p: Record<string, string | null>): DealStageEvent[] {
  const out: DealStageEvent[] = [];
  for (const [id, key] of Object.entries(AUTO_STAGE_BY_ID)) {
    const entered = toMs(p[`hs_v2_date_entered_${id}`] ?? null);
    if (!Number.isFinite(entered) || entered <= 0) continue;
    const exited = toMs(p[`hs_v2_date_exited_${id}`] ?? null);
    out.push({ stageKey: key, enteredMs: entered, exitedMs: Number.isFinite(exited) && exited > 0 ? exited : null });
  }
  return out.sort((a, b) => a.enteredMs - b.enteredMs);
}
