import { describe, it, expect } from "vitest";
import { segmentAccount } from "../lib/sync/segmentation";
import { DealStageKey } from "../config/deal-stages";

const keys = (...k: DealStageKey[]) => k;

describe("segmentAccount — SDR demo-status buckets", () => {
  describe("demo_pending — the SDR's real target list", () => {
    it("no deals at all is pending", () => {
      expect(segmentAccount([])).toMatchObject({ status: "demo_pending", furthestStageKey: null, hasRevivable: false });
    });

    it("an MQL-only deal is still pending (meeting not set)", () => {
      const r = segmentAccount(keys("mql"));
      expect(r.status).toBe("demo_pending");
      expect(r.furthestStageKey).toBe("mql");
    });

    it("only dead deals → pending, flagged revivable (previously worked)", () => {
      const r = segmentAccount(keys("drop_off_sdr"));
      expect(r.status).toBe("demo_pending");
      expect(r.hasRevivable).toBe(true);
      expect(r.furthestStageKey).toBeNull();
    });

    it("an out-of-funnel ('other') deal does not make an account scheduled", () => {
      expect(segmentAccount(keys("other")).status).toBe("demo_pending");
    });
  });

  describe("demo_scheduled — meeting set, demo not yet done", () => {
    it("discovery done is scheduled", () => {
      expect(segmentAccount(keys("discovery_done"))).toMatchObject({ status: "demo_scheduled", atRisk: false });
    });

    it("a no-show is scheduled but flagged at-risk", () => {
      expect(segmentAccount(keys("demo_no_show"))).toMatchObject({ status: "demo_scheduled", atRisk: true });
    });

    it("a reschedule is scheduled but flagged at-risk", () => {
      expect(segmentAccount(keys("demo_rescheduled")).atRisk).toBe(true);
    });

    it("mql + discovery_done → scheduled (the advanced deal governs)", () => {
      expect(segmentAccount(keys("mql", "discovery_done")).status).toBe("demo_scheduled");
    });

    it("a live discovery deal outranks a dead deal on the same account", () => {
      const r = segmentAccount(keys("drop_off_sales", "discovery_done"));
      expect(r.status).toBe("demo_scheduled");
      expect(r.hasRevivable).toBe(false); // there IS a live advanced deal — nothing to revive
    });
  });

  describe("demo_done — the demo has happened (AE's motion)", () => {
    it("demo done is done", () => {
      expect(segmentAccount(keys("demo_done")).status).toBe("demo_done");
    });
    it("in discussion is done", () => {
      expect(segmentAccount(keys("in_discussion")).status).toBe("demo_done");
    });
    it("contract closed (won) is done", () => {
      expect(segmentAccount(keys("contract_closed")).status).toBe("demo_done");
    });
    it("furthest stage wins: discovery_done + demo_done → done", () => {
      const r = segmentAccount(keys("discovery_done", "demo_done"));
      expect(r.status).toBe("demo_done");
      expect(r.furthestStageKey).toBe("demo_done");
    });
    it("won + dead → done (the won deal governs)", () => {
      expect(segmentAccount(keys("drop_off_sdr", "payment_completed")).status).toBe("demo_done");
    });
  });
});
