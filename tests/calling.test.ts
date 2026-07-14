import { describe, it, expect } from "vitest";
import { buildCallingDetail } from "../lib/sync/calling";
import { Activity } from "../lib/sync/types";
import { ContactMeta } from "../lib/sync/associate";
import { MEETING_SCHEDULED_GUID, CALLBACK_HIGH_GUID } from "../config/dispositions";

// Real portal GUIDs (config/dispositions.ts) so labels/classification match production.
const CONNECTED = "f240bbac-87c9-4f6e-bf70-924b57d47db7"; // "Connected"
const NO_ANSWER = "9afcb440-c2c4-44a7-9eb5-8f63e4896aeb"; // "NC - No Answer"

let seq = 0;
function call(over: Partial<Activity> = {}): Activity {
  seq++;
  return {
    id: `c${seq}`, type: "call", ownerId: "rep1", timestampMs: 1_000_000 + seq * 1000,
    disposition: NO_ANSWER, emailStatus: null, emailOpened: false, emailReplied: false,
    emailClicked: false, contactIds: [], companyIds: [], ...over,
  };
}

const META: Record<string, ContactMeta> = {
  ct1: { name: "Jane GM", title: "General Manager", dm: true },
  ct2: { name: "Bob Sales", title: "Sales Rep", dm: false },
};
const NAMES: Record<string, string> = { co1: "Main Street Motors", co2: "Hilltop Auto" };

describe("buildCallingDetail — summary", () => {
  it("counts dials, unique contacts/rooftops, connected uniqueness, and connect rate", () => {
    const d = buildCallingDetail([
      call({ contactIds: ["ct1"], companyIds: ["co1"], disposition: NO_ANSWER }),
      call({ contactIds: ["ct1"], companyIds: ["co1"], disposition: CONNECTED }),
      call({ contactIds: ["ct2"], companyIds: ["co2"], disposition: NO_ANSWER }),
      call({ contactIds: ["ct2"], companyIds: ["co2"], disposition: null }), // null disposition
    ], META, NAMES);

    expect(d.summary.calls).toBe(4);
    expect(d.summary.connected_calls).toBe(1);
    expect(d.summary.no_disposition).toBe(1);
    // null-disposition excluded from the denominator: 1 connected / (1 + 2 not)
    expect(d.summary.connect_rate).toBeCloseTo(1 / 3, 5);
    expect(d.summary.unique_contacts).toBe(2);
    expect(d.summary.contacts_connected).toBe(1); // only ct1 ever connected
    expect(d.summary.unique_rooftops).toBe(2);
    expect(d.summary.rooftops_connected).toBe(1); // only co1
  });

  it("counts meetings and unattributed calls; ignores non-call activities", () => {
    const d = buildCallingDetail([
      call({ contactIds: ["ct1"], companyIds: ["co1"], disposition: MEETING_SCHEDULED_GUID }),
      call({ contactIds: ["ct2"], companyIds: [] }), // no company → unattributed
      call({ type: "email", contactIds: ["ct1"], companyIds: ["co1"] }), // must be ignored
    ], META, NAMES);
    expect(d.summary.calls).toBe(2);
    expect(d.summary.meetings).toBe(1);
    expect(d.summary.unattributed_calls).toBe(1);
    expect(d.summary.unique_rooftops).toBe(1);
  });
});

describe("buildCallingDetail — outcomes", () => {
  it("groups by disposition label with counts, unique contacts, and connected flag, sorted by count", () => {
    const d = buildCallingDetail([
      call({ contactIds: ["ct1"], companyIds: ["co1"], disposition: NO_ANSWER }),
      call({ contactIds: ["ct2"], companyIds: ["co2"], disposition: NO_ANSWER }),
      call({ contactIds: ["ct1"], companyIds: ["co1"], disposition: NO_ANSWER }),
      call({ contactIds: ["ct1"], companyIds: ["co1"], disposition: CONNECTED }),
      call({ contactIds: ["ct2"], companyIds: ["co2"], disposition: null }),
    ], META, NAMES);

    expect(d.outcomes[0]).toEqual({ label: "NC - No Answer", count: 3, contacts: 2, connected: false });
    expect(d.outcomes).toContainEqual({ label: "Connected", count: 1, contacts: 1, connected: true });
    expect(d.outcomes).toContainEqual({ label: "No disposition", count: 1, contacts: 1, connected: false });
  });
});

describe("buildCallingDetail — contacts", () => {
  it("one row per unique contact: meta, company, per-outcome counts, last outcome, dials-desc order", () => {
    const d = buildCallingDetail([
      call({ contactIds: ["ct2"], companyIds: ["co2"], disposition: NO_ANSWER }),
      call({ contactIds: ["ct1"], companyIds: ["co1"], disposition: NO_ANSWER, timestampMs: 5_000 }),
      call({ contactIds: ["ct1"], companyIds: ["co1"], disposition: CONNECTED, timestampMs: 9_000 }),
      call({ contactIds: ["ct1"], companyIds: ["co1"], disposition: CALLBACK_HIGH_GUID, timestampMs: 20_000 }),
    ], META, NAMES);

    expect(d.contacts).toHaveLength(2);
    const [top, second] = d.contacts;
    expect(top.id).toBe("ct1"); // 3 dials > 1
    expect(top.name).toBe("Jane GM");
    expect(top.title).toBe("General Manager");
    expect(top.dm).toBe(true);
    expect(top.company_id).toBe("co1");
    expect(top.company_name).toBe("Main Street Motors");
    expect(top.calls).toBe(3);
    expect(top.connected).toBe(2); // "Connected" + callback-high are both connected dispositions
    expect(top.outcomes).toEqual({ "NC - No Answer": 1, Connected: 1, "C - Callback High Intent": 1 });
    expect(top.last_ms).toBe(20_000);
    expect(top.last_outcome).toBe("C - Callback High Intent");
    expect(second.id).toBe("ct2");
  });

  it("falls back to a readable name for unknown contacts and null company when unattributed", () => {
    const d = buildCallingDetail([call({ contactIds: ["ghost"], companyIds: [] })], META, NAMES);
    expect(d.contacts[0].name).toBe("Contact ghost");
    expect(d.contacts[0].company_id).toBeNull();
    expect(d.contacts[0].company_name).toBeNull();
  });
});

describe("buildCallingDetail — rooftops", () => {
  it("one row per unique company with nested who-was-called, meetings, dials-desc order", () => {
    const d = buildCallingDetail([
      call({ contactIds: ["ct1"], companyIds: ["co1"], disposition: NO_ANSWER }),
      call({ contactIds: ["ct2"], companyIds: ["co1"], disposition: MEETING_SCHEDULED_GUID }),
      call({ contactIds: ["ct2"], companyIds: ["co2"], disposition: NO_ANSWER }),
    ], META, NAMES);

    expect(d.rooftops).toHaveLength(2);
    const co1 = d.rooftops[0];
    expect(co1.id).toBe("co1");
    expect(co1.name).toBe("Main Street Motors");
    expect(co1.calls).toBe(2);
    expect(co1.connected).toBe(1); // meeting scheduled is a connected outcome
    expect(co1.meetings).toBe(1);
    expect(co1.contacts.map((c) => c.id).sort()).toEqual(["ct1", "ct2"]);
    expect(d.rooftops[1].id).toBe("co2");
  });

  it("a multi-company call counts once per company (same as the aggregate engine)", () => {
    const d = buildCallingDetail([
      call({ contactIds: ["ct1"], companyIds: ["co1", "co2"], disposition: CONNECTED }),
    ], META, NAMES);
    expect(d.summary.unique_rooftops).toBe(2);
    expect(d.rooftops.every((r) => r.calls === 1 && r.connected === 1)).toBe(true);
  });
});

describe("buildCallingDetail — call log", () => {
  it("is newest-first with resolved names and a connected flag", () => {
    const d = buildCallingDetail([
      call({ contactIds: ["ct1"], companyIds: ["co1"], disposition: CONNECTED, timestampMs: 1_000 }),
      call({ contactIds: ["ct2"], companyIds: ["co2"], disposition: NO_ANSWER, timestampMs: 2_000 }),
    ], META, NAMES);
    expect(d.log.map((l) => l.ts_ms)).toEqual([2_000, 1_000]);
    expect(d.log[1]).toMatchObject({
      contact_id: "ct1", contact_name: "Jane GM", company_id: "co1",
      company_name: "Main Street Motors", outcome: "Connected", connected: true,
    });
    expect(d.log_truncated).toBe(false);
  });

  it("caps the log at logCap keeping the newest rows, and flags truncation", () => {
    const calls = Array.from({ length: 5 }, (_, i) =>
      call({ contactIds: ["ct1"], companyIds: ["co1"], timestampMs: (i + 1) * 1000 }));
    const d = buildCallingDetail(calls, META, NAMES, { logCap: 3 });
    expect(d.log).toHaveLength(3);
    expect(d.log[0].ts_ms).toBe(5000);
    expect(d.log[2].ts_ms).toBe(3000);
    expect(d.log_truncated).toBe(true);
    expect(d.summary.calls).toBe(5); // summary keeps the true total
  });
});
