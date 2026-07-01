import { describe, it, expect } from "vitest";
import { aggregate } from "../lib/sync/aggregate";
import { makeIstContext } from "../lib/sync/buckets";
import { Activity } from "../lib/sync/types";

const NOW = Date.UTC(2026, 5, 29, 6, 30, 0); // noon IST
const REP = "69016314"; // Rajveer Singh (must exist in config/reps.ts)

const CONNECTED = "f240bbac-87c9-4f6e-bf70-924b57d47db7"; // "Connected"
const BUSY = "9d9162e7-6cf3-4944-bf63-4dff82258764"; // "Busy" -> not connected
const MEETING = "243ad062-d38f-40ea-86e2-10040d9ce4bd"; // "C - Meeting Scheduled" -> hot

function act(partial: Partial<Activity>): Activity {
  return {
    id: Math.random().toString(36).slice(2),
    type: "call", ownerId: REP, timestampMs: NOW,
    disposition: null, emailStatus: null,
    emailOpened: false, emailReplied: false, emailClicked: false,
    contactIds: [], companyIds: [],
    ...partial,
  };
}

describe("aggregate", () => {
  const ctx = makeIstContext(NOW);
  const activities: Activity[] = [
    act({ type: "call", disposition: CONNECTED, contactIds: ["A"], companyIds: ["X"] }),
    act({ type: "email", emailStatus: "SENT", emailOpened: true, contactIds: ["A"], companyIds: ["X"] }),
    act({ type: "call", disposition: BUSY, contactIds: ["B"], companyIds: ["X"] }),
    act({ type: "call", disposition: MEETING, contactIds: ["C"], companyIds: ["Y"] }),
  ];
  const owned = { [REP]: [{ id: "X", name: "Acme", lifecycle: "opportunity" }, { id: "Z", name: "Zeta", lifecycle: "lead" }] };
  const contactMeta = {
    A: { name: "Alice Owner", title: "Owner", dm: true },
    B: { name: "Bob Rep", title: "Sales Rep", dm: false },
    C: { name: "Carol", title: null, dm: false },
  };
  const snap = aggregate(
    activities,
    { X: "Acme", Y: "Yoyodyne" },
    { X: "opportunity", Y: "lead" },
    contactMeta,
    owned,
    ctx, NOW, { calls: true, emails: true },
  );
  const today = snap.reps[REP].periods.today;

  it("reports unique reach split by activity", () => {
    expect(today.contacts.total).toBe(3);
    expect(today.contacts.both).toBe(1); // A via call + email
    expect(today.companies.total).toBe(2);
  });

  it("tracks email engagement", () => {
    expect(today.emails.sent).toBe(1);
    expect(today.emails.opened).toBe(1);
    expect(today.emails.open_rate).toBe(1);
  });

  it("computes decision-maker reach", () => {
    expect(today.titled_contacts).toBe(2); // Owner + Sales Rep
    expect(today.dm_contacts).toBe(1); // Owner
  });

  it("classifies account temperature with reasons", () => {
    expect(today.temp.hot).toBe(1); // Y: meeting
    expect(today.temp.warm).toBe(1); // X: connected
    const rows = today.company_breakdown!;
    expect(rows.find((r) => r.id === "Y")!.temp_reason).toMatch(/meeting/i);
    expect(rows.find((r) => r.id === "X")!.temp_reason).toMatch(/connected/i);
  });

  it("computes coverage segmented by lifecycle (gd level)", () => {
    expect(today.coverage.owned_total).toBe(2);
    expect(today.coverage.owned_tapped).toBe(1); // X tapped
    expect(today.coverage.by_stage["In-pipeline"]).toEqual({ owned: 1, tapped: 1 }); // X = opportunity
    expect(today.coverage.by_stage["Lead/MQL"]).toEqual({ owned: 1, tapped: 0 }); // Z = lead, untapped
  });

  it("produces a quality score and insights", () => {
    expect(today.quality.score).toBeGreaterThan(0);
    expect(today.insights.some((i) => i.text.toLowerCase().includes("meeting"))).toBe(true);
  });

  it("attaches title/dm to per-account contacts", () => {
    const acme = today.company_breakdown!.find((r) => r.id === "X")!;
    const alice = acme.contacts_list!.find((c) => c.id === "A")!;
    expect(alice).toMatchObject({ name: "Alice Owner", title: "Owner", dm: true });
  });

  it("builds a daily series and does not leak into last_week", () => {
    const daily = snap.reps[REP].daily;
    expect(daily[daily.length - 1]).toMatchObject({ date: "2026-06-29", calls: 3, connected: 2, emails: 1 });
    expect(snap.reps[REP].periods.last_week.calls.total).toBe(0);
  });
});
