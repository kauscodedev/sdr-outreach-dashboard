import { describe, it, expect } from "vitest";
import { activityToRow, rowToActivity, rowToContactMeta, rowToOwnedCompany, dealToRow, rowToDeal, nextWatermark } from "../lib/spine/rows";
import { ActivityRow, CompanyRow, ContactRow, DealRow } from "../lib/spine/types";
import { Deal } from "../lib/sync/types";
import { AUTO_PIPELINE_ID } from "../config/deal-stages";

const act = { id: "42", type: "call" as const, ownerId: "69016314", timestampMs: 1000,
  disposition: "g", emailStatus: null, emailOpened: false, emailReplied: false,
  emailClicked: false, contactIds: ["c1"], companyIds: ["x"] };

describe("activity mappers", () => {
  it("round-trips through the row shape", () => {
    const row = activityToRow(act, 2000);
    expect(row).toMatchObject({ hs_id: "42", type: "call", owner_id: "69016314", ts_ms: 1000,
      contact_ids: ["c1"], company_ids: ["x"], hs_lastmodified_ms: 2000 });
    expect(rowToActivity(row)).toEqual(act);
  });
  it("tolerates jsonb arrays arriving as null", () => {
    const row = { ...activityToRow(act, 0), contact_ids: null, company_ids: null } as unknown as ActivityRow;
    const a = rowToActivity(row);
    expect(a.contactIds).toEqual([]);
    expect(a.companyIds).toEqual([]);
  });
  it("tolerates a jsonb array arriving as a non-array object", () => {
    const row = { ...activityToRow(act, 0), contact_ids: {} } as unknown as ActivityRow;
    expect(rowToActivity(row).contactIds).toEqual([]);
  });
});

describe("rowToOwnedCompany", () => {
  it("maps a company row to the OwnedCompany shape aggregate() expects", () => {
    const row: CompanyRow = { hs_id: "X", name: "Acme", gd_stage: "In Pipeline", lifecycle_stage: "customer",
      owner_id: "69016314", gd_id: "900", is_group: true, group_name: "Big", segment: "mm_group",
      dealership_type: "Franchise", last_activity_ms: 1700, rooftop_last_activity_ms: 1800, hs_lastmodified_ms: 1 };
    expect(rowToOwnedCompany(row)).toEqual({ id: "X", name: "Acme", gdStage: "In Pipeline",
      lifecycleStage: "customer", gdId: "900", isGroup: true, groupName: "Big", segment: "mm_group",
      dealershipType: "Franchise", lastActivityMs: 1700, rooftopLastActivityMs: 1800 });
  });
  it("falls back name to Company <id> and tolerates null lifecycle/last-activity", () => {
    const row: CompanyRow = { hs_id: "9", name: null, gd_stage: null, lifecycle_stage: null, owner_id: null,
      gd_id: null, is_group: false, group_name: null, segment: null, dealership_type: null,
      last_activity_ms: null, rooftop_last_activity_ms: null, hs_lastmodified_ms: null };
    const oc = rowToOwnedCompany(row);
    expect(oc.name).toBe("Company 9");
    expect(oc.lastActivityMs).toBeNull();
  });
});

describe("rowToContactMeta", () => {
  it("falls back name to Contact <id> and coerces dm to a strict boolean", () => {
    const row = { hs_id: "7", name: null, title: null, dm: 1 } as unknown as ContactRow;
    expect(rowToContactMeta(row)).toEqual({ name: "Contact 7", title: null, dm: true });
  });
});

describe("deal mappers", () => {
  const deal: Deal = {
    id: "d1", pipeline: AUTO_PIPELINE_ID, dealstage: "1534611154", stageKey: "in_discussion",
    dealOwnerId: "ae1", sdrOwnerId: "sdr1", companyId: "co1", contactIds: ["c1", "c2"],
    amount: 5000, demoScheduledForMs: 111, discoveryDoneMs: 222, demoDoneMs: 333,
  };

  it("round-trips an in-funnel deal through the row shape", () => {
    const row = dealToRow(deal, 999);
    expect(row).toMatchObject({
      hs_id: "d1", pipeline: AUTO_PIPELINE_ID, dealstage: "1534611154", stage_key: "in_discussion",
      deal_owner_id: "ae1", sdr_owner_id: "sdr1", company_id: "co1", contact_ids: ["c1", "c2"],
      amount: 5000, demo_scheduled_for_ms: 111, discovery_done_ms: 222, demo_done_ms: 333,
      is_closed_won: false, is_closed_lost: false, hs_lastmodified_ms: 999,
    });
    expect(rowToDeal(row)).toEqual(deal);
  });

  it("derives is_closed_won for Contract Closed", () => {
    const row = dealToRow({ ...deal, dealstage: "1534611156", stageKey: "contract_closed" }, 1);
    expect(row.stage_key).toBe("contract_closed");
    expect(row.is_closed_won).toBe(true);
    expect(row.is_closed_lost).toBe(false);
  });

  it("derives is_closed_lost for Drop off (Sales)", () => {
    const row = dealToRow({ ...deal, dealstage: "1534611160", stageKey: "drop_off_sales" }, 1);
    expect(row.is_closed_lost).toBe(true);
    expect(row.is_closed_won).toBe(false);
  });

  it("recomputes stageKey from (pipeline, dealstage) on read — mapping stays the source of truth", () => {
    // A stored stage_key that has gone stale is corrected on read from the raw pair.
    const row = { ...dealToRow(deal, 1), stage_key: "mql" } as DealRow;
    expect(rowToDeal(row).stageKey).toBe("in_discussion");
  });

  it("tolerates jsonb contact_ids arriving as null", () => {
    const row = { ...dealToRow(deal, 0), contact_ids: null } as unknown as DealRow;
    expect(rowToDeal(row).contactIds).toEqual([]);
  });
});

describe("nextWatermark", () => {
  it("advances to the max lastmodified seen", () => {
    expect(nextWatermark(100, [{ lastModifiedMs: 150 }, { lastModifiedMs: 120 }])).toBe(150);
  });
  it("keeps the previous watermark when nothing changed or fields missing", () => {
    expect(nextWatermark(100, [])).toBe(100);
    expect(nextWatermark(100, [{ lastModifiedMs: undefined }])).toBe(100);
  });
  it("never goes backwards", () => {
    expect(nextWatermark(200, [{ lastModifiedMs: 150 }])).toBe(200);
  });
});
