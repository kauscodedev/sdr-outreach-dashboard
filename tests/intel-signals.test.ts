import { describe, it, expect } from "vitest";
import { buildSignalsPrompt, coerceSignals, needsRescan, SignalChunk, SignalMeta } from "../lib/intel/signals";

const META = new Map<string, SignalMeta>([
  ["a1", { accountId: "co1", ownerId: "rep1", tsMs: 1_000, kind: "call" }],
  ["a2", { accountId: "co2", ownerId: "rep2", tsMs: 2_000, kind: "email" }],
]);

describe("buildSignalsPrompt", () => {
  it("renders one section per chunk with the exact id, kind, and content", () => {
    const chunks: SignalChunk[] = [
      { hsId: "a1", kind: "call", tsMs: Date.UTC(2026, 6, 1, 16), chunk: "Prospect said too expensive" },
      { hsId: "a2", kind: "email", tsMs: null, chunk: "Asked for a proposal" },
    ];
    const p = buildSignalsPrompt(chunks);
    expect(p).toContain("item id=a1 · call · Jul 01, 2026");
    expect(p).toContain("item id=a2 · email · undated");
    expect(p).toContain("Prospect said too expensive");
    expect(p).toContain("Asked for a proposal");
  });
});

describe("coerceSignals", () => {
  it("accepts valid signals and attaches the activity meta", () => {
    const { rows, perItem } = coerceSignals({
      results: [{ id: "a1", signals: [{ label: "objection", category: "price", quote: "too expensive for us", confidence: 0.9 }] }],
    }, META, "test-model");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hs_id: "a1", account_id: "co1", owner_id: "rep1", ts_ms: 1_000, kind: "call",
      label: "objection", category: "price", quote: "too expensive for us", confidence: 0.9, model: "test-model",
    });
    expect(perItem.get("a1")).toBe(1);
  });

  it("drops unknown item ids (never attributes to the wrong activity)", () => {
    const { rows } = coerceSignals({
      results: [{ id: "GHOST", signals: [{ label: "objection", category: "price", quote: "x" }] }],
    }, META, "m");
    expect(rows).toHaveLength(0);
  });

  it("drops unknown labels and quote-less signals; records zero-signal items in perItem", () => {
    const { rows, perItem } = coerceSignals({
      results: [
        { id: "a1", signals: [{ label: "vibes", quote: "q" }, { label: "objection", category: "price", quote: "" }] },
        { id: "a2", signals: [] },
      ],
    }, META, "m");
    expect(rows).toHaveLength(0);
    expect(perItem.get("a1")).toBe(0); // scanned, nothing valid
    expect(perItem.get("a2")).toBe(0); // scanned, clean
  });

  it("falls back objection categories to 'other' and timing to 'someday'; clamps confidence", () => {
    const { rows } = coerceSignals({
      results: [{
        id: "a1",
        signals: [
          { label: "objection", category: "totally-made-up", quote: "no thanks", confidence: 7 },
          { label: "timing", category: "eventually", quote: "maybe next year", confidence: -2 },
        ],
      }],
    }, META, "m");
    expect(rows[0]).toMatchObject({ label: "objection", category: "other", confidence: 1 });
    expect(rows[1]).toMatchObject({ label: "timing", category: "someday", confidence: 0 });
  });

  it("keeps competitor names as given and caps signals per item at 4", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ label: "buying_signal", quote: `q${i}` }));
    const { rows } = coerceSignals({
      results: [{ id: "a1", signals: [{ label: "competitor_mention", category: "Impel", quote: "they use Impel" }, ...five] }],
    }, META, "m");
    expect(rows[0]).toMatchObject({ label: "competitor_mention", category: "Impel" });
    expect(rows).toHaveLength(4); // 1 competitor + 3 of the 5 buying signals
  });

  it("tolerates garbage input shapes", () => {
    expect(coerceSignals(null, META, "m").rows).toHaveLength(0);
    expect(coerceSignals({ results: "nope" }, META, "m").rows).toHaveLength(0);
    expect(coerceSignals({}, META, "m").rows).toHaveLength(0);
  });
});

describe("needsRescan", () => {
  it("re-scans only when content grew past 1.4x (the late-transcript case)", () => {
    expect(needsRescan(150, 100)).toBe(true);
    expect(needsRescan(140, 100)).toBe(false); // exactly 1.4x is NOT a rescan
    expect(needsRescan(100, 100)).toBe(false);
    expect(needsRescan(50, 100)).toBe(false); // shrunk content never re-queues
  });
});
