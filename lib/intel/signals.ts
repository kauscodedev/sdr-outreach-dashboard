/**
 * Signals engine — PURE half (prompt build + output coercion; unit-tested). The nightly runner
 * lives in signals-run.ts (server-only). Extraction reads the SAME composed chunks the embedding
 * index uses (composeChunk), so what the Themes view counts is exactly what search retrieves.
 */
import { COMPETITOR_SEEDS } from "../../config/competitors";
import { SIGNAL_LABELS, OBJECTION_CATEGORIES, SignalLabel } from "./types";

/** One content-bearing activity going into a scan batch. */
export interface SignalChunk {
  hsId: string;
  kind: string | null; // 'call' | 'email'
  tsMs: number | null;
  chunk: string; // composeChunk() output
}

/** Activity meta attached to extracted signals (same attribution as sdr_embeddings). */
export interface SignalMeta {
  accountId: string | null;
  ownerId: string | null;
  tsMs: number | null;
  kind: string | null;
}

/** A coerced signal row, ready for the sdr_intel_signals insert (snake_case = DB columns). */
export interface SignalRow {
  hs_id: string;
  account_id: string | null;
  owner_id: string | null;
  ts_ms: number | null;
  kind: string | null;
  label: SignalLabel;
  category: string | null;
  quote: string;
  confidence: number | null;
  model: string;
}

export const SIGNALS_SYSTEM = `You are a revenue-intelligence tagger for an automotive-dealership software sales team.
You are given a numbered batch of call/email content items. For EACH item, extract the clear buyer/seller signals — or an empty list if there are none (most routine items have none; that is the correct answer, do not force signals).

Signal labels (use ONLY these):
- "objection": the prospect pushed back or declined. Set "category" to one of: ${OBJECTION_CATEGORIES.join(", ")}.
- "competitor_mention": a competing vendor or alternative solution came up. Set "category" to the competitor's name — normalize onto these when they match: ${COMPETITOR_SEEDS.join(", ")}; otherwise pass the name through as heard.
- "pricing_question": the prospect asked about cost/pricing structure (asking ≠ objecting).
- "buying_signal": concrete positive intent — asked for a demo/proposal, discussed rollout, brought in a decision maker, asked implementation questions.
- "risk_phrase": language that threatens a live deal — "on hold", "budget freeze", "went quiet", "re-evaluating", "leadership change".
- "commitment": OUR REP promised something concrete (send pricing, follow up Tuesday, loop in AE).
- "timing": the prospect signalled WHEN they'd act. Set "category" to one of: now, this_quarter, next_quarter, someday.

Rules:
- "quote": a near-verbatim excerpt (≤200 chars) from the item that evidences the signal. Never paraphrase into words that aren't there; never invent.
- "confidence": 0..1 — how unambiguous the signal is.
- At most 4 signals per item. Skip vague pleasantries, voicemail scripts, and template boilerplate.
Return STRICT JSON: {"results":[{"id":"<item id>","signals":[{"label":"...","category":"... or null","quote":"...","confidence":0.0}]}]} — one entry per item, in the given order, echoing each item's id exactly.`;

/** Render one scan batch (≤8 chunks) as the user prompt. */
export function buildSignalsPrompt(chunks: SignalChunk[]): string {
  const day = (ms: number | null) =>
    ms ? new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", year: "numeric" }) : "undated";
  return chunks
    .map((c) => `### item id=${c.hsId} · ${c.kind ?? "?"} · ${day(c.tsMs)}\n${c.chunk}`)
    .join("\n\n");
}

const LABELS = new Set<string>(SIGNAL_LABELS);
const OBJ_CATS = new Set<string>(OBJECTION_CATEGORIES);
const TIMING_CATS = new Set(["now", "this_quarter", "next_quarter", "someday"]);
const MAX_PER_ITEM = 4;
const QUOTE_CAP = 240;

/**
 * Validate + coerce one batch response into insertable rows. Drops: unknown item ids, unknown
 * labels, quote-less signals. Objection categories fall back to "other"; timing categories to
 * "someday"; confidence clamps to [0,1].
 */
export function coerceSignals(
  raw: unknown,
  metaById: Map<string, SignalMeta>,
  model: string,
): { rows: SignalRow[]; perItem: Map<string, number> } {
  const rows: SignalRow[] = [];
  const perItem = new Map<string, number>();
  const results = (raw as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(results)) return { rows, perItem };

  for (const entry of results as Record<string, unknown>[]) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const meta = metaById.get(id);
    if (!meta) continue; // unknown/mangled id — never attribute to the wrong activity
    if (!perItem.has(id)) perItem.set(id, 0);

    const signals = Array.isArray(entry.signals) ? (entry.signals as Record<string, unknown>[]) : [];
    for (const s of signals.slice(0, MAX_PER_ITEM)) {
      const label = typeof s.label === "string" ? s.label.trim() : "";
      const quote = typeof s.quote === "string" ? s.quote.trim().slice(0, QUOTE_CAP) : "";
      if (!LABELS.has(label) || !quote) continue;

      let category = typeof s.category === "string" ? s.category.trim() : "";
      if (label === "objection") category = OBJ_CATS.has(category) ? category : "other";
      else if (label === "timing") category = TIMING_CATS.has(category) ? category : "someday";
      else if (!category) category = "";

      rows.push({
        hs_id: id,
        account_id: meta.accountId,
        owner_id: meta.ownerId,
        ts_ms: meta.tsMs,
        kind: meta.kind,
        label: label as SignalLabel,
        category: category || null,
        quote,
        confidence: typeof s.confidence === "number" ? Math.max(0, Math.min(1, s.confidence)) : null,
        model,
      });
      perItem.set(id, (perItem.get(id) ?? 0) + 1);
    }
  }
  return { rows, perItem };
}

/** Should a previously scanned row be re-scanned? Only when its content grew substantially
 *  (the late-transcript case: a call row lands with just a title, the transcript arrives later). */
export function needsRescan(newChunkLen: number, scannedLen: number): boolean {
  return newChunkLen > scannedLen * 1.4;
}
