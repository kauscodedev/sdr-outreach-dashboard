/**
 * AE Deal Radar — PURE builder (unit-tested; loaders live in the API route). Live deals ranked
 * by how loudly they're asking for attention: recent risk language from the mined signals
 * (objections / risk phrases / competitor mentions), stage staleness from the event ledger, and
 * Deal Health. Reuses the canonical stage predicates and the health classifier — never
 * re-derives stage logic.
 */
import { Deal } from "../sync/types";
import { isActive, stageLabel } from "../../config/deal-stages";
import { classifyDealHealth } from "../sync/deal-health";
import { RadarDeal, RadarSignal } from "./types";

export const STALE_DAYS = 14; // matches the Deal Health yellow ladder
/** No account activity for this long → the deal is integrity-queue material, not radar
 *  material (observed live: ~3.9k "active" deals untouched for 100-1200 days would otherwise
 *  bury every actionable one). Kept visible, but sunk below everything actionable. */
export const ZOMBIE_MS = 90 * 86_400_000;
const DAY_MS = 86_400_000;

export interface RadarCompanyMeta {
  name: string | null;
  lastActivityMs: number | null;
}

const HEALTH_ORDER: Record<string, number> = { red: 0, yellow: 1, green: 2 };
const zombieRank = (lastActivityMs: number | null | undefined, nowMs: number): number =>
  lastActivityMs != null && nowMs - lastActivityMs <= ZOMBIE_MS ? 0 : 1;

export function buildRadar(args: {
  deals: Deal[];
  companyMeta: Map<string, RadarCompanyMeta>;
  signalsByAccount: Map<string, RadarSignal[]>;
  nowMs: number;
}): RadarDeal[] {
  const { deals, companyMeta, signalsByAccount, nowMs } = args;
  const out: RadarDeal[] = [];

  for (const d of deals) {
    if (!isActive(d.stageKey)) continue;

    // Time in the CURRENT stage — the open ledger entry (exited_ms null). Ledger absent → null.
    let daysInStage: number | null = null;
    for (const e of d.stageEvents ?? []) {
      if (e.exitedMs == null && e.stageKey === d.stageKey) {
        daysInStage = Math.floor((nowMs - e.enteredMs) / DAY_MS);
        break;
      }
    }

    const meta = d.companyId ? companyMeta.get(d.companyId) : undefined;
    const hr = classifyDealHealth({
      stageKey: d.stageKey,
      demoScheduledForMs: d.demoScheduledForMs,
      lastActivityMs: meta?.lastActivityMs ?? null,
      nowMs,
    });

    out.push({
      dealId: d.id,
      accountId: d.companyId,
      accountName: meta?.name ?? null,
      stageKey: d.stageKey,
      stageLabel: stageLabel(d.stageKey),
      amount: d.amount,
      aeId: d.dealOwnerId,
      sdrId: d.sdrOwnerId,
      daysInStage,
      stale: (daysInStage ?? 0) > STALE_DAYS,
      lastActivityMs: meta?.lastActivityMs ?? null,
      health: hr.health,
      healthReason: hr.reason,
      riskSignals: d.companyId ? (signalsByAccount.get(d.companyId) ?? []).slice(0, 3) : [],
    });
  }

  return out.sort((a, b) => {
    const riskA = a.riskSignals.length > 0 ? 0 : 1;
    const riskB = b.riskSignals.length > 0 ? 0 : 1;
    if (riskA !== riskB) return riskA - riskB;
    const zA = zombieRank(a.lastActivityMs, nowMs);
    const zB = zombieRank(b.lastActivityMs, nowMs);
    if (zA !== zB) return zA - zB; // deals with a live conversation outrank long-dead ones
    const hA = HEALTH_ORDER[a.health ?? ""] ?? 3;
    const hB = HEALTH_ORDER[b.health ?? ""] ?? 3;
    if (hA !== hB) return hA - hB;
    if ((b.daysInStage ?? 0) !== (a.daysInStage ?? 0)) return (b.daysInStage ?? 0) - (a.daysInStage ?? 0);
    return (b.amount ?? 0) - (a.amount ?? 0);
  });
}
