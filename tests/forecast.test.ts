import { describe, it, expect } from "vitest";
import { computeForecast, MIN_COHORT } from "../lib/sync/forecast";
import { Deal, DealStageEvent } from "../lib/sync/types";
import { DealStageKey, AUTO_PIPELINE_ID } from "../config/deal-stages";

const DAY = 86_400_000;

function deal(p: Partial<Deal> & { id: string; stageKey: DealStageKey }): Deal {
  return {
    pipeline: AUTO_PIPELINE_ID, dealstage: null, dealOwnerId: null, sdrOwnerId: null,
    companyId: null, contactIds: [], amount: null,
    demoScheduledForMs: null, discoveryDoneMs: null, demoDoneMs: null, ...p,
  };
}
const ev = (stageKey: DealStageKey, enteredMs: number, exitedMs: number | null = null): DealStageEvent =>
  ({ stageKey, enteredMs, exitedMs });

describe("computeForecast — resolved-cohort conversion + velocity + expected value", () => {
  // Cohort through in_discussion: 30 resolved (18 won incl. one transferred, 12 lost) + 1 live.
  const resolved: Deal[] = [
    ...Array.from({ length: 17 }, (_, i) => deal({
      id: `w${i}`, stageKey: "contract_closed",
      stageEvents: [ev("in_discussion", 100, 100 + 10 * DAY), ev("contract_closed", 100 + 10 * DAY)],
    })),
    deal({ id: "cs", stageKey: "transferred_cs", stageEvents: [ev("in_discussion", 50, 50 + 20 * DAY)] }),
    ...Array.from({ length: 12 }, (_, i) => deal({
      id: `l${i}`, stageKey: "drop_off_sales",
      stageEvents: [ev("in_discussion", 200, 200 + 5 * DAY)],
    })),
  ];
  const live = deal({ id: "live1", stageKey: "in_discussion", amount: 10_000, stageEvents: [ev("in_discussion", 500)] });
  const f = computeForecast([...resolved, live]);
  const disc = f.by_stage.in_discussion!;

  it("conversion = won / RESOLVED (live deals excluded from the denominator)", () => {
    expect(disc.entered).toBe(31);
    expect(disc.resolved).toBe(30);
    expect(disc.won).toBe(18); // 17 closed + 1 transferred to CS
    expect(disc.conversion).toBeCloseTo(0.6);
  });

  it("median stay uses completed stays only", () => {
    expect(disc.median_days).toBe(10); // 17×10d, 1×20d, 12×5d → median 10
  });

  it("expected value = amount × conversion(current stage) over active deals with amounts", () => {
    expect(f.active_total).toBe(1);
    expect(f.active_with_amount).toBe(1);
    expect(f.pipeline_amount).toBe(10_000);
    expect(f.expected_value).toBeCloseTo(6_000);
  });

  it("reports null conversion below MIN_COHORT — honest '—' over noise", () => {
    const tiny = computeForecast([
      deal({ id: "a", stageKey: "contract_closed", stageEvents: [ev("demo_accepted", 1, 2)] }),
      deal({ id: "b", stageKey: "demo_accepted", amount: 500, stageEvents: [ev("demo_accepted", 3)] }),
    ]);
    expect(tiny.by_stage.demo_accepted!.resolved).toBeLessThan(MIN_COHORT);
    expect(tiny.by_stage.demo_accepted!.conversion).toBeNull();
    expect(tiny.expected_value).toBe(0); // no conversion → nothing to weight
    expect(tiny.pipeline_amount).toBe(500); // raw pipeline still reported
  });

  it("counts a pre-ledger deal's CURRENT stage as entered", () => {
    const f2 = computeForecast([deal({ id: "old", stageKey: "demo_done" })]);
    expect(f2.by_stage.demo_done!.entered).toBe(1);
  });

  it("splits cohorts from actives: rates from full history, $ from the windowed set", () => {
    const windowedActive = deal({ id: "w", stageKey: "in_discussion", amount: 4_000 });
    const outsideActive = deal({ id: "o", stageKey: "in_discussion", amount: 100_000 });
    const f3 = computeForecast([...resolved, windowedActive, outsideActive], [windowedActive]);
    expect(f3.by_stage.in_discussion!.conversion).toBeCloseTo(0.6); // full-history cohort
    expect(f3.active_total).toBe(1); // only the windowed deal counts toward $
    expect(f3.pipeline_amount).toBe(4_000);
    expect(f3.expected_value).toBeCloseTo(2_400);
  });
});
