import { describe, it, expect } from "vitest";
import { stageEventsOf } from "../lib/sync/stage-events";
import { dealStageEventRows, rowToStageEvent } from "../lib/spine/rows";
import { Deal } from "../lib/sync/types";
import { AUTO_PIPELINE_ID } from "../config/deal-stages";

// Real Auto Pipeline stage ids (config/deal-stages.ts).
const DISCOVERY = "1534610164"; // discovery_done
const ACCEPTED = "1534611153"; // demo_accepted
const MQL = "1534610163"; // mql

describe("stageEventsOf — hs_v2 stage-date properties → stage-event ledger", () => {
  it("extracts entered/exited per mapped stage and sorts by entered_ms", () => {
    const ev = stageEventsOf({
      [`hs_v2_date_entered_${DISCOVERY}`]: "1700000000000",
      [`hs_v2_date_exited_${DISCOVERY}`]: "1700500000000",
      [`hs_v2_date_entered_${MQL}`]: "1699000000000",
      dealstage: ACCEPTED, // unrelated properties are ignored
    });
    expect(ev).toEqual([
      { stageKey: "mql", enteredMs: 1699000000000, exitedMs: null },
      { stageKey: "discovery_done", enteredMs: 1700000000000, exitedMs: 1700500000000 },
    ]);
  });

  it("parses ISO datetime values (the API returns ISO for datetime properties)", () => {
    const ev = stageEventsOf({ [`hs_v2_date_entered_${ACCEPTED}`]: "2026-07-01T12:00:00Z" });
    expect(ev).toEqual([
      { stageKey: "demo_accepted", enteredMs: Date.UTC(2026, 6, 1, 12), exitedMs: null },
    ]);
  });

  it("skips stages with no entered date, and empty/garbage values", () => {
    expect(stageEventsOf({})).toEqual([]);
    expect(stageEventsOf({ [`hs_v2_date_entered_${MQL}`]: "" })).toEqual([]);
    expect(stageEventsOf({ [`hs_v2_date_entered_${MQL}`]: null })).toEqual([]);
    // an exited date with no entered date is not an event
    expect(stageEventsOf({ [`hs_v2_date_exited_${MQL}`]: "1700000000000" })).toEqual([]);
  });
});

describe("stage-event row mappers", () => {
  const deal: Deal = {
    id: "d9", pipeline: AUTO_PIPELINE_ID, dealstage: ACCEPTED, stageKey: "demo_accepted",
    dealOwnerId: "ae1", sdrOwnerId: "sdr1", companyId: "co1", contactIds: [],
    amount: null, demoScheduledForMs: null, discoveryDoneMs: null, demoDoneMs: null,
    stageEvents: [
      { stageKey: "discovery_done", enteredMs: 100, exitedMs: 200 },
      { stageKey: "demo_accepted", enteredMs: 200, exitedMs: null },
    ],
  };

  it("maps a deal's ledger to sdr_deal_stage_events rows", () => {
    expect(dealStageEventRows(deal)).toEqual([
      { deal_id: "d9", stage_key: "discovery_done", entered_ms: 100, exited_ms: 200 },
      { deal_id: "d9", stage_key: "demo_accepted", entered_ms: 200, exited_ms: null },
    ]);
  });

  it("returns no rows for a deal without a ledger (pre-V3)", () => {
    expect(dealStageEventRows({ ...deal, stageEvents: undefined })).toEqual([]);
  });

  it("round-trips a row back to the event shape (bigints may arrive as strings)", () => {
    const row = { deal_id: "d9", stage_key: "discovery_done", entered_ms: "100", exited_ms: null };
    expect(rowToStageEvent(row as never)).toEqual({ stageKey: "discovery_done", enteredMs: 100, exitedMs: null });
  });
});
