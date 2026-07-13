import { describe, it, expect } from "vitest";
import {
  AUTO_PIPELINE_ID,
  stageKey,
  stageLabel,
  isWon,
  isLost,
  isMeetingSet,
  isPostDemo,
  isDemoCompletedStage,
  isParked,
  isTerminal,
  isActive,
  stageOrder,
  DealStageKey,
} from "../config/deal-stages";

describe("stageKey — canonical (pipeline, dealstage) → key", () => {
  it("maps Auto Pipeline stage ids to canonical keys", () => {
    expect(stageKey(AUTO_PIPELINE_ID, "1534610163")).toBe("mql");
    expect(stageKey(AUTO_PIPELINE_ID, "1534610164")).toBe("discovery_done");
    expect(stageKey(AUTO_PIPELINE_ID, "1534610165")).toBe("demo_no_show");
    expect(stageKey(AUTO_PIPELINE_ID, "1534610166")).toBe("demo_rescheduled");
    expect(stageKey(AUTO_PIPELINE_ID, "1534611151")).toBe("demo_done");
    expect(stageKey(AUTO_PIPELINE_ID, "1534611152")).toBe("non_sal");
    expect(stageKey(AUTO_PIPELINE_ID, "1534611153")).toBe("demo_accepted");
    expect(stageKey(AUTO_PIPELINE_ID, "1534611154")).toBe("in_discussion");
    expect(stageKey(AUTO_PIPELINE_ID, "1534611159")).toBe("future_prospect");
    expect(stageKey(AUTO_PIPELINE_ID, "1534611156")).toBe("contract_closed");
    expect(stageKey(AUTO_PIPELINE_ID, "1534611157")).toBe("payment_completed");
    // "drop off ae" is really Drop off (Sales); Drop Off (SDR) is a distinct id.
    expect(stageKey(AUTO_PIPELINE_ID, "1534611161")).toBe("drop_off_sdr");
    expect(stageKey(AUTO_PIPELINE_ID, "1534611160")).toBe("drop_off_sales");
  });

  it("does NOT resolve an Auto-US stage id — pipeline collision guard", () => {
    // 1534462664 = "Discovery Call Done" in Auto Pipeline US (1001270003), NOT Auto.
    // Keying on the id alone would be a bug; we only map ids that belong to Auto Pipeline.
    expect(stageKey("1001270003", "1534462664")).toBe("other");
    // And an Auto-US id accidentally paired with the Auto pipeline is unknown → other.
    expect(stageKey(AUTO_PIPELINE_ID, "1534462664")).toBe("other");
  });

  it("returns 'other' for out-of-funnel stages, unknown ids, and null/empty", () => {
    expect(stageKey(AUTO_PIPELINE_ID, "1534610167")).toBe("other"); // Upsell
    expect(stageKey(AUTO_PIPELINE_ID, "999999")).toBe("other");
    expect(stageKey(AUTO_PIPELINE_ID, "")).toBe("other");
    expect(stageKey(AUTO_PIPELINE_ID, null)).toBe("other");
    expect(stageKey("1001269997", "1534611156")).toBe("other"); // CS pipeline → out of scope
  });
});

describe("stage predicates", () => {
  it("isWon covers only closed-won terminals", () => {
    expect(isWon("contract_closed")).toBe(true);
    expect(isWon("payment_completed")).toBe(true);
    expect(isWon("in_discussion")).toBe(false);
    expect(isWon("discovery_done")).toBe(false);
  });

  it("isLost covers SDR/sales drop-offs and Non SAL", () => {
    expect(isLost("drop_off_sdr")).toBe(true);
    expect(isLost("drop_off_sales")).toBe(true);
    expect(isLost("non_sal")).toBe(true);
    expect(isLost("demo_done")).toBe(false);
  });

  it("isMeetingSet = demo booked but not yet done", () => {
    expect(isMeetingSet("discovery_done")).toBe(true);
    expect(isMeetingSet("demo_no_show")).toBe(true);
    expect(isMeetingSet("demo_rescheduled")).toBe(true);
    expect(isMeetingSet("demo_done")).toBe(false);
    expect(isMeetingSet("mql")).toBe(false);
  });

  it("isPostDemo = the demo has happened (through won/CS)", () => {
    expect(isPostDemo("demo_done")).toBe(true);
    expect(isPostDemo("demo_accepted")).toBe(true);
    expect(isPostDemo("in_discussion")).toBe(true);
    expect(isPostDemo("future_prospect")).toBe(true);
    expect(isPostDemo("contract_closed")).toBe(true);
    expect(isPostDemo("transferred_cs")).toBe(true);
    expect(isPostDemo("discovery_done")).toBe(false);
    expect(isPostDemo("drop_off_sales")).toBe(false);
  });
});

describe("V3 predicates — demo-completed / parked / terminal / active", () => {
  it("isDemoCompletedStage covers all three completion stages (locked decision: all 3 count)", () => {
    expect(isDemoCompletedStage("demo_done")).toBe(true);
    expect(isDemoCompletedStage("demo_accepted")).toBe(true);
    expect(isDemoCompletedStage("in_discussion")).toBe(true);
    expect(isDemoCompletedStage("discovery_done")).toBe(false);
    expect(isDemoCompletedStage("contract_initiated")).toBe(false);
  });

  it("isParked = Future Prospect only (locked decision: parked, not active)", () => {
    expect(isParked("future_prospect")).toBe(true);
    expect(isParked("in_discussion")).toBe(false);
    expect(isParked("drop_off_sales")).toBe(false);
  });

  it("isTerminal = won + lost + transferred to CS", () => {
    expect(isTerminal("contract_closed")).toBe(true);
    expect(isTerminal("payment_completed")).toBe(true);
    expect(isTerminal("transferred_cs")).toBe(true);
    expect(isTerminal("drop_off_sdr")).toBe(true);
    expect(isTerminal("non_sal")).toBe(true);
    expect(isTerminal("contract_initiated")).toBe(false);
    expect(isTerminal("future_prospect")).toBe(false);
  });

  it("isActive = in-funnel, not terminal, not parked — both motions", () => {
    // SDR motion (pre-demo)
    expect(isActive("mql")).toBe(true);
    expect(isActive("discovery_done")).toBe(true);
    expect(isActive("demo_no_show")).toBe(true);
    expect(isActive("demo_rescheduled")).toBe(true);
    // AE motion (post-demo)
    expect(isActive("demo_done")).toBe(true);
    expect(isActive("demo_accepted")).toBe(true);
    expect(isActive("in_discussion")).toBe(true);
    expect(isActive("contract_initiated")).toBe(true);
    // Not active: parked, terminal, out-of-funnel
    expect(isActive("future_prospect")).toBe(false);
    expect(isActive("contract_closed")).toBe(false);
    expect(isActive("transferred_cs")).toBe(false);
    expect(isActive("drop_off_sales")).toBe(false);
    expect(isActive("other")).toBe(false);
  });
});

describe("stageOrder — funnel progression for picking the furthest deal", () => {
  it("advances monotonically down the funnel", () => {
    expect(stageOrder("payment_completed")).toBeGreaterThan(stageOrder("in_discussion"));
    expect(stageOrder("in_discussion")).toBeGreaterThan(stageOrder("demo_done"));
    expect(stageOrder("demo_done")).toBeGreaterThan(stageOrder("discovery_done"));
    expect(stageOrder("discovery_done")).toBeGreaterThan(stageOrder("mql"));
  });

  it("dead / out-of-funnel stages carry no funnel progress", () => {
    expect(stageOrder("drop_off_sdr")).toBe(0);
    expect(stageOrder("drop_off_sales")).toBe(0);
    expect(stageOrder("non_sal")).toBe(0);
    expect(stageOrder("other")).toBe(0);
  });
});

describe("stageLabel — human-readable", () => {
  it("returns a readable label per key", () => {
    expect(stageLabel("discovery_done")).toMatch(/discovery/i);
    expect(stageLabel("drop_off_sales")).toMatch(/drop off \(sales\)/i);
    const k: DealStageKey = "in_discussion";
    expect(stageLabel(k)).toMatch(/discussion/i);
  });
});
