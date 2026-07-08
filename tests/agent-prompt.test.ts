import { describe, it, expect } from "vitest";
import { buildUserPrompt } from "../lib/agent/prompt";
import { AccountContext, HotAccount, TimelineEvent } from "../lib/agent/types";

describe("buildUserPrompt", () => {
  const mockAccount: HotAccount = {
    accountId: "12345",
    accountName: "Test dealership",
    repId: "rep-1",
    repName: "Alice Rep",
    temp: "hot",
    tempReason: "High intent callback received",
    stage: "Contracting",
    meetings: 1,
    highIntent: 2,
    connected: 3,
    opened: 4,
    replied: 1,
    calls: 5,
    emails: 6,
    disqualified: false,
    lastSignalMs: Date.UTC(2026, 6, 8, 12, 0, 0),
  };

  it("handles empty timeline gracefully", () => {
    const ctx: AccountContext = {
      account: mockAccount,
      coachingSummary: "Focus on presenting product advantages.",
      callSnippets: ["Objection: Price is high", "Quote: 'Let me think about it'"],
      timeline: [],
    };

    const prompt = buildUserPrompt(ctx);
    expect(prompt).toContain("ACCOUNT: Test dealership (rooftop id 12345)");
    expect(prompt).toContain("OWNER (SDR): Alice Rep");
    expect(prompt).toContain("[No timeline activities available]");
  });

  it("renders a detailed timeline with multiple events, contacts, and content", () => {
    const mockTimeline: TimelineEvent[] = [
      {
        hsId: "act-1",
        type: "email",
        tsMs: Date.UTC(2026, 6, 7, 10, 0, 0),
        dateStr: "Jul 07, 2026 10:00:00 ET",
        disposition: null,
        emailStatus: "OPENED",
        emailOpened: true,
        emailReplied: false,
        emailClicked: true,
        contacts: [
          { hsId: "ct-1", name: "John GM", title: "General Manager", dm: true },
        ],
        content: {
          callTitle: null,
          callBody: null,
          callSummary: null,
          transcript: null,
          emailSubject: "Boost your rooftop sales",
        },
      },
      {
        hsId: "act-2",
        type: "call",
        tsMs: Date.UTC(2026, 6, 8, 11, 0, 0),
        dateStr: "Jul 08, 2026 11:00:00 ET",
        disposition: "Callback High Intent",
        emailStatus: null,
        emailOpened: false,
        emailReplied: false,
        emailClicked: false,
        contacts: [
          { hsId: "ct-1", name: "John GM", title: "General Manager", dm: true },
          { hsId: "ct-2", name: "Sarah BDC", title: "BDC Agent", dm: false },
        ],
        content: {
          callTitle: "Discovery call with John",
          callBody: "John wants to see a demo tomorrow.",
          callSummary: "John showed high interest in the software solutions.",
          transcript: "SDR: Hi John\nJohn: Hello, let's schedule a call tomorrow.",
          emailSubject: null,
        },
      },
    ];

    const ctx: AccountContext = {
      account: mockAccount,
      coachingSummary: "Rep is doing great.",
      callSnippets: ["Prospect was very receptive"],
      timeline: mockTimeline,
    };

    const prompt = buildUserPrompt(ctx);
    expect(prompt).toContain("CHRONOLOGICAL ACTIVITY TIMELINE");
    expect(prompt).toContain("- [Jul 07, 2026 10:00:00 ET] EMAIL");
    expect(prompt).toContain("John GM (General Manager, Decision Maker)");
    expect(prompt).toContain("Status: OPENED");
    expect(prompt).toContain('Email Subject: "Boost your rooftop sales"');
    
    expect(prompt).toContain("- [Jul 08, 2026 11:00:00 ET] CALL");
    expect(prompt).toContain("John GM (General Manager, Decision Maker), Sarah BDC (BDC Agent)");
    expect(prompt).toContain("Outcome / Disposition: Callback High Intent");
    expect(prompt).toContain("Call Title: Discovery call with John");
    expect(prompt).toContain("Call Summary: John showed high interest in the software solutions.");
    expect(prompt).toContain("Call Body (Notes): John wants to see a demo tomorrow.");
    expect(prompt).toContain("Call Transcript:\n    SDR: Hi John\n    John: Hello, let's schedule a call tomorrow.");
  });
});
