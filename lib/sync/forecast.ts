/**
 * Forecast v1 (heuristic, not ML) — pure, over deals + their stage-event ledgers.
 *
 * Per-stage historical conversion is computed over RESOLVED cohorts only ("of deals that ever
 * entered stage S and have since won or lost, what share won?") so live deals don't drag the
 * rate down. Expected pipeline value = Σ amount × conversion(current stage) over ACTIVE deals
 * that carry an amount — coverage is reported honestly rather than imputed. Stage velocity =
 * median days spent in a stage (exited ledger entries only). Cohorts under MIN_COHORT report
 * null — an honest "—" beats a noisy percentage. Upgrade to a model only when the ledger has
 * months of history (blueprint §7.4).
 */
import { Deal } from "./types";
import { DealStageKey, FUNNEL_STAGES, isActive, isLost, isWon } from "../../config/deal-stages";

export interface StageForecast {
  entered: number; // deals that ever entered this stage (ledger; current stage counts)
  resolved: number; // of those, now won or lost — the conversion denominator
  won: number; // of resolved, won (incl. Transferred to CS — a successful exit)
  conversion: number | null; // won / resolved; null when resolved < MIN_COHORT
  median_days: number | null; // median time spent in the stage (completed stays only)
}

export interface Forecast {
  by_stage: Partial<Record<DealStageKey, StageForecast>>;
  active_total: number;
  active_with_amount: number; // active deals carrying an amount (coverage of expected_value)
  pipeline_amount: number; // Σ amounts of active deals (unweighted)
  expected_value: number; // Σ amount × conversion(current stage), where both are known
}

export const MIN_COHORT = 20;

const wonNow = (d: Deal): boolean => isWon(d.stageKey) || d.stageKey === "transferred_cs";
const resolvedNow = (d: Deal): boolean => wonNow(d) || isLost(d.stageKey);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @param deals       the conversion/velocity cohort — pass FULL history here so rates stay stable
 *                    when the UI narrows its window
 * @param activeDeals the set expected value + pipeline are computed over (defaults to `deals`) —
 *                    pass the WINDOWED view so the $ numbers match what's on screen
 */
export function computeForecast(deals: Deal[], activeDeals: Deal[] = deals): Forecast {
  const acc = new Map<DealStageKey, { entered: number; resolved: number; won: number; stays: number[] }>();
  for (const k of FUNNEL_STAGES) acc.set(k, { entered: 0, resolved: 0, won: 0, stays: [] });

  for (const d of deals) {
    // Stages this deal ever entered: the ledger, plus its current stage (covers pre-ledger deals).
    const entered = new Set<DealStageKey>();
    if (acc.has(d.stageKey)) entered.add(d.stageKey);
    for (const e of d.stageEvents ?? []) {
      if (acc.has(e.stageKey)) entered.add(e.stageKey);
      if (e.exitedMs != null && e.exitedMs > e.enteredMs && acc.has(e.stageKey)) {
        acc.get(e.stageKey)!.stays.push((e.exitedMs - e.enteredMs) / 86_400_000);
      }
    }
    const resolved = resolvedNow(d);
    const won = wonNow(d);
    for (const k of entered) {
      const a = acc.get(k)!;
      a.entered++;
      if (resolved) { a.resolved++; if (won) a.won++; }
    }
  }

  const by_stage: Partial<Record<DealStageKey, StageForecast>> = {};
  for (const [k, a] of acc) {
    by_stage[k] = {
      entered: a.entered,
      resolved: a.resolved,
      won: a.won,
      conversion: a.resolved >= MIN_COHORT ? a.won / a.resolved : null,
      median_days: median(a.stays),
    };
  }

  let active_total = 0, active_with_amount = 0, pipeline_amount = 0, expected_value = 0;
  for (const d of activeDeals) {
    if (!isActive(d.stageKey)) continue;
    active_total++;
    if (d.amount == null) continue;
    active_with_amount++;
    pipeline_amount += d.amount;
    const conv = by_stage[d.stageKey]?.conversion;
    if (conv != null) expected_value += d.amount * conv;
  }

  return { by_stage, active_total, active_with_amount, pipeline_amount, expected_value };
}
