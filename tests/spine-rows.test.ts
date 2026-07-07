import { describe, it, expect } from "vitest";
import { activityToRow, rowToActivity, rowToOwnedCompany, nextWatermark } from "../lib/spine/rows";
import { ActivityRow, CompanyRow } from "../lib/spine/types";

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
});

describe("rowToOwnedCompany", () => {
  it("maps a company row to the OwnedCompany shape aggregate() expects", () => {
    const row: CompanyRow = { hs_id: "X", name: "Acme", gd_stage: "In Pipeline", owner_id: "69016314",
      gd_id: "900", is_group: true, group_name: "Big", segment: "mm_group",
      dealership_type: "Franchise", hs_lastmodified_ms: 1 };
    expect(rowToOwnedCompany(row)).toEqual({ id: "X", name: "Acme", gdStage: "In Pipeline",
      gdId: "900", isGroup: true, groupName: "Big", segment: "mm_group", dealershipType: "Franchise" });
  });
  it("falls back name to Company <id>", () => {
    const row: CompanyRow = { hs_id: "9", name: null, gd_stage: null, owner_id: null, gd_id: null,
      is_group: false, group_name: null, segment: null, dealership_type: null, hs_lastmodified_ms: null };
    expect(rowToOwnedCompany(row).name).toBe("Company 9");
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
