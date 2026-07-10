import { describe, it, expect } from "vitest";
import { classifyDealHealth, DealHealthInput } from "../lib/sync/deal-health";
import { DealStageKey } from "../config/deal-stages";

const NOW = Date.UTC(2026, 6, 10);
const DAY = 86_400_000;
function inp(p: Partial<DealHealthInput> & { stageKey: DealStageKey }): DealHealthInput {
  return { demoScheduledForMs: null, lastActivityMs: NOW, nowMs: NOW, ...p };
}

describe("classifyDealHealth", () => {
  describe("terminal states short-circuit the recency ladder", () => {
    it("a dropped deal is RED even if just touched", () => {
      expect(classifyDealHealth(inp({ stageKey: "drop_off_sdr", lastActivityMs: NOW })).health).toBe("red");
      expect(classifyDealHealth(inp({ stageKey: "drop_off_sales" })).health).toBe("red");
      expect(classifyDealHealth(inp({ stageKey: "non_sal" })).health).toBe("red");
    });
    it("a won deal is GREEN even if quiet for months", () => {
      expect(classifyDealHealth(inp({ stageKey: "contract_closed", lastActivityMs: NOW - 90 * DAY })).health).toBe("green");
      expect(classifyDealHealth(inp({ stageKey: "payment_completed", lastActivityMs: NOW - 90 * DAY })).health).toBe("green");
    });
  });

  describe("meeting-set stages", () => {
    it("upcoming scheduled demo is GREEN", () => {
      const r = classifyDealHealth(inp({ stageKey: "discovery_done", demoScheduledForMs: NOW + 2 * DAY }));
      expect(r.health).toBe("green");
      expect(r.reason).toMatch(/demo/i);
    });
    it("a demo date already passed with no advance is YELLOW immediately", () => {
      const r = classifyDealHealth(inp({ stageKey: "discovery_done", demoScheduledForMs: NOW - DAY }));
      expect(r.health).toBe("yellow");
      expect(r.reason).toMatch(/passed/i);
    });
    it("no-show and rescheduled are YELLOW", () => {
      expect(classifyDealHealth(inp({ stageKey: "demo_no_show" })).health).toBe("yellow");
      expect(classifyDealHealth(inp({ stageKey: "demo_rescheduled" })).health).toBe("yellow");
    });
  });

  describe("recency ladder for active stages (14d → Yellow, 30d → Red)", () => {
    it("recently touched is GREEN", () => {
      expect(classifyDealHealth(inp({ stageKey: "in_discussion", lastActivityMs: NOW - 5 * DAY })).health).toBe("green");
    });
    it("quiet 14–30d is YELLOW (boundary at exactly 14d)", () => {
      expect(classifyDealHealth(inp({ stageKey: "in_discussion", lastActivityMs: NOW - 14 * DAY })).health).toBe("yellow");
      expect(classifyDealHealth(inp({ stageKey: "demo_done", lastActivityMs: NOW - 20 * DAY })).health).toBe("yellow");
    });
    it("quiet 30d+ is RED (boundary at exactly 30d)", () => {
      expect(classifyDealHealth(inp({ stageKey: "in_discussion", lastActivityMs: NOW - 30 * DAY })).health).toBe("red");
      expect(classifyDealHealth(inp({ stageKey: "demo_accepted", lastActivityMs: NOW - 45 * DAY })).health).toBe("red");
    });
    it("no recorded activity on a live deal is YELLOW (unknown, needs attention)", () => {
      expect(classifyDealHealth(inp({ stageKey: "demo_done", lastActivityMs: null })).health).toBe("yellow");
    });
  });

  describe("parked", () => {
    it("future prospect is YELLOW (parked, revisit)", () => {
      const r = classifyDealHealth(inp({ stageKey: "future_prospect", lastActivityMs: NOW - 90 * DAY }));
      expect(r.health).toBe("yellow");
      expect(r.reason).toMatch(/future|parked/i);
    });
  });
});
