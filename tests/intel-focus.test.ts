import { describe, it, expect } from "vitest";
import { buildFocus, isReviveCandidate, FocusActionState, REVIVE_QUIET_MIN_MS, REVIVE_QUIET_MAX_MS } from "../lib/intel/focus";
import { AgentWatch } from "../lib/agent/types";
import { RooftopDetail, AccountDeal } from "../lib/sync/types";

const NOW = Date.UTC(2026, 6, 15, 16); // fixed "now"
const DAY = 86_400_000;

function watch(over: Partial<AgentWatch> = {}): AgentWatch {
  return {
    accountId: "co1", accountName: "Alpha Motors", repId: "rep1", status: "watching",
    temp: "hot", reason: "Meeting-level intent on the 10th", nextStep: "Call the GM",
    priority: "high", confidence: 0.8, enteredHotAt: null, lastSignalMs: NOW - DAY,
    lastReviewedAt: null, model: "m", ...over,
  };
}

function deal(over: Partial<AccountDeal> = {}): AccountDeal {
  return {
    demo_status: "demo_pending", at_risk: false, has_revivable: false,
    stage: null, stage_key: null, health: null, health_reason: null, deal_count: 1, ...over,
  };
}

function rooftop(over: Partial<RooftopDetail> = {}): RooftopDetail {
  return {
    id: "co2", name: "Beta Autos", tapped: true, coverage: "tapped",
    calls: 5, emails: 2, connected: 1, opened: 0, replied: 0, meetings: 0,
    high_intent: 0, negative: 0, disqualified: false,
    last_ms: NOW - 20 * DAY, temp: "warm", temp_reason: "", contacts: [], ...over,
  };
}

const noActions = new Map<string, FocusActionState>();
const noSignals = new Map<string, { label: "objection"; quote: string; tsMs: number | null }[]>();

const build = (watches: AgentWatch[], rooftops: RooftopDetail[], actions = noActions) =>
  buildFocus({ watches, rooftops, actions, signalsByAccount: noSignals, nowMs: NOW });

describe("isReviveCandidate", () => {
  it("requires a positive signal, the 14-30d quiet window, and no disqualification", () => {
    expect(isReviveCandidate(rooftop({ replied: 1 }), NOW)).toBe(true);
    expect(isReviveCandidate(rooftop({ replied: 1, disqualified: true }), NOW)).toBe(false);
    expect(isReviveCandidate(rooftop(), NOW)).toBe(false); // no positive signal
    expect(isReviveCandidate(rooftop({ meetings: 1, last_ms: NOW - 13 * DAY }), NOW)).toBe(false); // too fresh
    expect(isReviveCandidate(rooftop({ meetings: 1, last_ms: NOW - 31 * DAY }), NOW)).toBe(false); // too cold
    expect(isReviveCandidate(rooftop({ meetings: 1, last_ms: NOW - REVIVE_QUIET_MIN_MS }), NOW)).toBe(true); // edge in
    expect(isReviveCandidate(rooftop({ meetings: 1, last_ms: NOW - REVIVE_QUIET_MAX_MS }), NOW)).toBe(true); // edge in
    expect(isReviveCandidate(rooftop({ meetings: 1, last_ms: null }), NOW)).toBe(false);
  });

  it("excludes accounts already in a live advanced deal, but keeps revivable dead-deal ones", () => {
    expect(isReviveCandidate(rooftop({ replied: 1, deal: deal({ demo_status: "demo_scheduled" }) }), NOW)).toBe(false);
    expect(isReviveCandidate(rooftop({ replied: 1, deal: deal({ demo_status: "demo_pending" }) }), NOW)).toBe(true);
    expect(isReviveCandidate(rooftop({ replied: 1, deal: deal({ demo_status: "demo_done", has_revivable: true }) }), NOW)).toBe(true);
  });
});

describe("buildFocus", () => {
  it("merges the three buckets and dedupes with watch precedence", () => {
    const items = build(
      [watch({ accountId: "co2", accountName: "Beta Autos" })], // same account as the rooftop below
      [
        rooftop({ id: "co2", replied: 1 }), // would be a revive candidate — watch wins
        rooftop({ id: "co3", name: "Gamma Cars", deal: deal({ demo_status: "demo_scheduled", at_risk: true, health_reason: "Demo date passed" }) }),
        rooftop({ id: "co4", name: "Delta Trucks", meetings: 1 }),
      ],
    );
    const byId = new Map(items.map((i) => [i.accountId, i]));
    expect(byId.get("co2")?.bucket).toBe("watch");
    expect(byId.get("co3")?.bucket).toBe("at_risk_demo");
    expect(byId.get("co3")?.why).toBe("Demo date passed");
    expect(byId.get("co3")?.priority).toBe("high");
    expect(byId.get("co4")?.bucket).toBe("revive");
    expect(byId.get("co4")?.why).toMatch(/meeting-level intent.*quiet 20d/);
    expect(items).toHaveLength(3);
  });

  it("skips dropped/closed watches", () => {
    const items = build([watch({ status: "drop_off" }), watch({ accountId: "co9", status: "closed" })], []);
    expect(items).toHaveLength(0);
  });

  it("sinks completed/snoozed items and treats expired snoozes as active again", () => {
    const actions = new Map<string, FocusActionState>([
      ["co2", { status: "completed", snoozedUntil: null }],
      ["co4", { status: "snoozed", snoozedUntil: new Date(NOW - DAY).toISOString() }], // expired
    ]);
    const items = build(
      [watch({ accountId: "co2", accountName: "Beta" }), watch({ accountId: "co4", accountName: "Delta", priority: "low" })],
      [], actions,
    );
    const byId = new Map(items.map((i) => [i.accountId, i]));
    expect(byId.get("co2")?.actionStatus).toBe("completed");
    expect(byId.get("co4")?.actionStatus).toBe("not_started"); // snooze expired → back to work
    expect(items[items.length - 1].accountId).toBe("co2"); // completed sinks below the active one
  });

  it("orders actives by priority then bucket (at-risk demos above watches at equal priority)", () => {
    const items = build(
      [watch({ accountId: "w1", priority: "high" }), watch({ accountId: "w2", priority: "low" })],
      [rooftop({ id: "d1", deal: deal({ demo_status: "demo_scheduled", at_risk: true }) })],
    );
    // d1 is high priority (at_risk_demo) and outranks the high-priority watch via bucket order.
    expect(items.map((i) => i.accountId)).toEqual(["d1", "w1", "w2"]);
  });
});
