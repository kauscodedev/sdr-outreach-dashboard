import { describe, it, expect } from "vitest";
import { runIntegrityChecks, CompanyRef, STALE_DAYS } from "../lib/integrity/checks";
import { Deal, DealStageEvent } from "../lib/sync/types";
import { DealStageKey, AUTO_PIPELINE_ID } from "../config/deal-stages";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function deal(p: Partial<Deal> & { id: string; stageKey: DealStageKey }): Deal {
  return {
    pipeline: AUTO_PIPELINE_ID, dealstage: null, dealOwnerId: null, sdrOwnerId: null,
    companyId: null, contactIds: [], amount: null,
    demoScheduledForMs: null, discoveryDoneMs: null, demoDoneMs: null, ...p,
  };
}
const ev = (stageKey: DealStageKey, enteredMs: number, exitedMs: number | null = null): DealStageEvent =>
  ({ stageKey, enteredMs, exitedMs });

const companies = new Map<string, CompanyRef>([
  ["co1", { name: "Acme Auto", owner_id: "S1" }],
  ["co2", { name: "Beta Motors", owner_id: "S9" }],
]);

const kinds = (items: { kind: string; deal_id: string }[]) =>
  items.map((i) => `${i.kind}:${i.deal_id}`).sort();

describe("runIntegrityChecks", () => {
  it("flags ACTIVE orphans only (a lost orphan is history, not a task)", () => {
    const items = runIntegrityChecks([
      deal({ id: "a", stageKey: "in_discussion", contactIds: ["c1"] }), // active orphan
      deal({ id: "b", stageKey: "drop_off_sales" }), // lost orphan → ignored
    ], companies, NOW);
    expect(kinds(items)).toEqual(["orphan_deal:a"]);
    expect(items[0].suggestion).toMatch(/contact/i);
  });

  it("flags a slipped demo (meeting-set stage, demo date in the past)", () => {
    const items = runIntegrityChecks([
      deal({ id: "s", stageKey: "discovery_done", companyId: "co1", demoScheduledForMs: NOW - 10 * DAY }),
      deal({ id: "ok", stageKey: "discovery_done", companyId: "co1", demoScheduledForMs: NOW + DAY }),
    ], companies, NOW);
    const slipped = items.filter((i) => i.kind === "slipped_demo");
    expect(slipped).toHaveLength(1);
    expect(slipped[0]).toMatchObject({ deal_id: "s", severity: "high", company_name: "Acme Auto" });
  });

  it("flags stale active deals by days-in-stage (30d medium, 60d high)", () => {
    const items = runIntegrityChecks([
      deal({ id: "st", stageKey: "demo_accepted", companyId: "co1", sdrOwnerId: "S1",
        stageEvents: [ev("demo_accepted", NOW - (STALE_DAYS + 5) * DAY)] }),
      deal({ id: "vst", stageKey: "demo_accepted", companyId: "co1", sdrOwnerId: "S1",
        stageEvents: [ev("demo_accepted", NOW - 70 * DAY)] }),
      deal({ id: "fresh", stageKey: "demo_accepted", companyId: "co1", sdrOwnerId: "S1",
        stageEvents: [ev("demo_accepted", NOW - 5 * DAY)] }),
    ], companies, NOW);
    const stale = items.filter((i) => i.kind === "stale_active");
    expect(stale.map((i) => `${i.deal_id}:${i.severity}`).sort()).toEqual(["st:medium", "vst:high"]);
  });

  it("flags SDR-owner vs account-owner mismatch on active deals", () => {
    const items = runIntegrityChecks([
      deal({ id: "m", stageKey: "in_discussion", companyId: "co2", sdrOwnerId: "S1" }), // co2 owned by S9
      deal({ id: "okm", stageKey: "in_discussion", companyId: "co1", sdrOwnerId: "S1" }), // aligned
    ], companies, NOW);
    expect(items.filter((i) => i.kind === "owner_mismatch").map((i) => i.deal_id)).toEqual(["m"]);
  });

  it("flags a backward stage move from the ledger (once per deal)", () => {
    const items = runIntegrityChecks([
      deal({ id: "r", stageKey: "discovery_done", companyId: "co1", sdrOwnerId: "S1", stageEvents: [
        ev("in_discussion", NOW - 20 * DAY, NOW - 10 * DAY),
        ev("discovery_done", NOW - 10 * DAY),
      ] }),
    ], companies, NOW);
    const reg = items.filter((i) => i.kind === "stage_regression");
    expect(reg).toHaveLength(1);
    expect(reg[0].detail).toMatch(/In Discussion → Discovery Call Done/);
  });

  it("sorts high severity first, then newest signal", () => {
    const items = runIntegrityChecks([
      deal({ id: "med", stageKey: "in_discussion", companyId: "co2", sdrOwnerId: "S1" }), // medium
      deal({ id: "hi", stageKey: "in_discussion" }), // high (orphan)
    ], companies, NOW);
    expect(items[0].severity).toBe("high");
  });
});
