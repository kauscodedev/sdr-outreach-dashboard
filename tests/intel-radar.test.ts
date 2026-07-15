import { describe, it, expect } from "vitest";
import { buildRadar, RadarCompanyMeta, STALE_DAYS } from "../lib/intel/radar";
import { Deal, DealStageEvent } from "../lib/sync/types";
import { RadarSignal } from "../lib/intel/types";

const NOW = Date.UTC(2026, 6, 15, 16);
const DAY = 86_400_000;

function deal(over: Partial<Deal> = {}): Deal {
  return {
    id: "d1", pipeline: "1001348836", dealstage: "x", stageKey: "discovery_done",
    dealOwnerId: "ae1", sdrOwnerId: "sdr1", companyId: "co1", contactIds: [],
    amount: 1000, demoScheduledForMs: null, discoveryDoneMs: null, demoDoneMs: null, ...over,
  };
}

const openEvent = (stageKey: Deal["stageKey"], enteredDaysAgo: number): DealStageEvent =>
  ({ stageKey, enteredMs: NOW - enteredDaysAgo * DAY, exitedMs: null });

const META = new Map<string, RadarCompanyMeta>([
  ["co1", { name: "Alpha Motors", lastActivityMs: NOW - DAY }],
  ["co2", { name: "Beta Autos", lastActivityMs: NOW - DAY }],
]);
const NO_SIGNALS = new Map<string, RadarSignal[]>();

const build = (deals: Deal[], signals = NO_SIGNALS, meta = META) =>
  buildRadar({ deals, companyMeta: meta, signalsByAccount: signals, nowMs: NOW });

describe("buildRadar", () => {
  it("keeps only ACTIVE stages (won/lost/parked/other excluded)", () => {
    const out = build([
      deal({ id: "d1", stageKey: "discovery_done" }),
      deal({ id: "d2", stageKey: "contract_closed" }),
      deal({ id: "d3", stageKey: "future_prospect" }), // parked by decision
      deal({ id: "d4", stageKey: "other" }),
    ]);
    expect(out.map((d) => d.dealId)).toEqual(["d1"]);
  });

  it("derives days-in-stage from the OPEN ledger event and flags staleness past 14d", () => {
    const out = build([
      deal({ id: "d1", stageEvents: [openEvent("discovery_done", 20)] }),
      deal({ id: "d2", companyId: "co2", stageEvents: [openEvent("discovery_done", 3)] }),
      deal({ id: "d3", companyId: "co2" }), // no ledger → null, not stale
    ]);
    const byId = new Map(out.map((d) => [d.dealId, d]));
    expect(byId.get("d1")).toMatchObject({ daysInStage: 20, stale: true });
    expect(byId.get("d2")).toMatchObject({ daysInStage: 3, stale: false });
    expect(byId.get("d3")).toMatchObject({ daysInStage: null, stale: false });
    expect(STALE_DAYS).toBe(14);
  });

  it("ignores CLOSED ledger events for a stage the deal has left", () => {
    const out = build([deal({
      stageEvents: [
        { stageKey: "discovery_done", enteredMs: NOW - 40 * DAY, exitedMs: NOW - 20 * DAY },
        openEvent("discovery_done", 5),
      ],
    })]);
    expect(out[0].daysInStage).toBe(5);
  });

  it("attaches account name + health and caps risk signals at 3", () => {
    const signals = new Map<string, RadarSignal[]>([["co1", [
      { label: "objection", category: "price", quote: "q1", tsMs: NOW },
      { label: "risk_phrase", category: null, quote: "q2", tsMs: NOW },
      { label: "competitor_mention", category: "Impel", quote: "q3", tsMs: NOW },
      { label: "objection", category: "budget", quote: "q4", tsMs: NOW },
    ]]]);
    const out = build([deal()], signals);
    expect(out[0].accountName).toBe("Alpha Motors");
    expect(out[0].riskSignals).toHaveLength(3);
    expect(out[0].health).not.toBeNull(); // recent activity → classifier returns a verdict
  });

  it("sorts voiced-risk first, then health severity, then days-in-stage, then amount", () => {
    const signals = new Map<string, RadarSignal[]>([["co2", [{ label: "risk_phrase", category: null, quote: "on hold", tsMs: NOW }]]]);
    const out = build([
      deal({ id: "quiet-stale", companyId: "co1", stageEvents: [openEvent("discovery_done", 30)] }),
      deal({ id: "risky", companyId: "co2", stageEvents: [openEvent("discovery_done", 2)] }),
      deal({ id: "quiet-fresh-big", companyId: "co1", amount: 99_000, stageEvents: [openEvent("discovery_done", 30)] }),
    ], signals);
    expect(out[0].dealId).toBe("risky"); // voiced risk beats everything
    // Same health + same staleness → bigger amount first.
    expect(out.slice(1).map((d) => d.dealId)).toEqual(["quiet-fresh-big", "quiet-stale"]);
  });

  it("tolerates deals with no company metadata", () => {
    const out = build([deal({ companyId: "unknown-co" })], NO_SIGNALS);
    expect(out[0]).toMatchObject({ accountName: null, riskSignals: [] });
  });

  it("sinks zombie deals (no account activity >90d) below actionable ones, even stale-red ones", () => {
    const meta = new Map<string, RadarCompanyMeta>([
      ["co1", { name: "Zombie Corp", lastActivityMs: NOW - 300 * DAY }],
      ["co2", { name: "Live Wire", lastActivityMs: NOW - 2 * DAY }],
    ]);
    const out = build([
      deal({ id: "zombie", companyId: "co1", stageEvents: [openEvent("discovery_done", 400)] }),
      deal({ id: "live", companyId: "co2", stageEvents: [openEvent("discovery_done", 5)] }),
    ], NO_SIGNALS, meta);
    expect(out.map((d) => d.dealId)).toEqual(["live", "zombie"]);
    // But a VOICED risk on a zombie still outranks a quiet live deal (risk is tier one).
    const signals = new Map<string, RadarSignal[]>([["co1", [{ label: "risk_phrase", category: null, quote: "on hold", tsMs: NOW }]]]);
    const out2 = build([
      deal({ id: "zombie", companyId: "co1", stageEvents: [openEvent("discovery_done", 400)] }),
      deal({ id: "live", companyId: "co2", stageEvents: [openEvent("discovery_done", 5)] }),
    ], signals, meta);
    expect(out2.map((d) => d.dealId)).toEqual(["zombie", "live"]);
  });
});
