/**
 * Signals engine — nightly runner (server-only). Scans NEW sdr_activity_content rows (plus
 * rows whose content grew — late transcripts), extracts typed signals via completeJSON in
 * 8-chunk batches, and writes sdr_intel_signals + the sdr_intel_scans ledger. Idempotent:
 * the ledger records every scanned row (even signal-less ones), mirroring indexNewContent's
 * anti-join pattern. Runs after embed:content in spine-reconcile.yml.
 */
import "server-only";
import { supabaseAdmin } from "../supabase/admin";
import { completeJSON, AGENT_MODEL, isConfigured } from "../agent/openai";
import { composeChunk, ContentFields } from "../agent/embed-chunks";
import { SIGNALS_SYSTEM, buildSignalsPrompt, coerceSignals, needsRescan, SignalChunk, SignalMeta } from "./signals";

const PAGE = 1000;
const BATCH = 8; // chunks per LLM call
const DEFAULT_CAP = Number(process.env.INTEL_SCAN_CAP) || 2500; // rows per run (~315 LLM calls)

export interface SignalScanResult { skipped: boolean; scanned: number; signals: number; errors: number }

export async function runSignalScan(opts: { limit?: number } = {}): Promise<SignalScanResult> {
  const db = supabaseAdmin();
  if (!db) return { skipped: true, scanned: 0, signals: 0, errors: 0 };
  if (!isConfigured()) {
    console.warn("[signals] OPENAI_API_KEY not set — skipping");
    return { skipped: true, scanned: 0, signals: 0, errors: 0 };
  }
  const cap = opts.limit ?? DEFAULT_CAP;

  // Scan ledger (paged — fits in memory like the embeddings id set).
  const scanned = new Map<string, number>(); // hs_id -> content_len at scan time
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("sdr_intel_scans").select("hs_id,content_len").order("hs_id").range(from, from + PAGE - 1);
    if (error) {
      console.warn(`[signals] sdr_intel_scans unavailable (${error.message}) — apply the Intelligence 2.0 migration first`);
      return { skipped: true, scanned: 0, signals: 0, errors: 0 };
    }
    for (const r of data ?? []) scanned.set(String(r.hs_id), Number(r.content_len));
    if (!data || data.length < PAGE) break;
  }

  let scannedNow = 0, signalsFound = 0, errors = 0;

  for (let from = 0; ; from += PAGE) {
    // hs_id DESCENDING ≈ newest activities first — the capped backfill fills Themes with
    // CURRENT conversations first; the ledger anti-join converges on the tail either way.
    const { data: rows, error } = await db.from("sdr_activity_content")
      .select("hs_id,type,call_title,call_body,call_summary,transcript,email_subject,email_body")
      .order("hs_id", { ascending: false }).range(from, from + PAGE - 1);
    if (error) throw new Error(`[signals] read content: ${error.message}`);
    const page = rows ?? [];

    // Candidates on this page: unscanned, or content grew past the rescan threshold.
    const fresh: { hsId: string; chunk: string; rescan: boolean }[] = [];
    for (const r of page) {
      const chunk = composeChunk(r as ContentFields);
      if (!chunk) continue;
      const prev = scanned.get(String(r.hs_id));
      if (prev == null) fresh.push({ hsId: String(r.hs_id), chunk, rescan: false });
      else if (needsRescan(chunk.length, prev)) fresh.push({ hsId: String(r.hs_id), chunk, rescan: true });
    }

    if (fresh.length) {
      // Activity meta for attribution (same read the embeddings indexer does).
      const metaById = new Map<string, SignalMeta>();
      const kindById = new Map<string, string | null>();
      for (let i = 0; i < fresh.length; i += 500) {
        const ids = fresh.slice(i, i + 500).map((f) => f.hsId);
        const { data: acts } = await db.from("sdr_activities").select("hs_id,type,owner_id,ts_ms,company_ids").in("hs_id", ids);
        for (const a of acts ?? []) {
          const companies = Array.isArray(a.company_ids) ? a.company_ids.map(String) : [];
          metaById.set(String(a.hs_id), {
            accountId: companies[0] ?? null,
            ownerId: a.owner_id == null ? null : String(a.owner_id),
            tsMs: a.ts_ms == null ? null : Number(a.ts_ms),
            kind: a.type ?? null,
          });
          kindById.set(String(a.hs_id), a.type ?? null);
        }
      }

      // Re-scanned rows: replace their old signals so counts don't double.
      const rescanIds = fresh.filter((f) => f.rescan).map((f) => f.hsId);
      for (let i = 0; i < rescanIds.length; i += 200) {
        const { error: delErr } = await db.from("sdr_intel_signals").delete().in("hs_id", rescanIds.slice(i, i + 200));
        if (delErr) console.warn("[signals] rescan delete:", delErr.message);
      }

      for (let i = 0; i < fresh.length; i += BATCH) {
        if (scannedNow >= cap) break;
        const batch = fresh.slice(i, i + BATCH);
        const chunks: SignalChunk[] = batch.map((b) => ({
          hsId: b.hsId, chunk: b.chunk,
          kind: kindById.get(b.hsId) ?? null,
          tsMs: metaById.get(b.hsId)?.tsMs ?? null,
        }));
        try {
          const raw = await completeJSON(SIGNALS_SYSTEM, buildSignalsPrompt(chunks));
          const { rows: sigRows, perItem } = coerceSignals(raw, metaById, AGENT_MODEL);

          if (sigRows.length) {
            const { error: insErr } = await db.from("sdr_intel_signals").insert(sigRows as unknown as Record<string, unknown>[]);
            if (insErr) throw new Error(insErr.message);
            signalsFound += sigRows.length;
          }
          // Ledger rows for the WHOLE batch — signal-less items are done too. Items the model
          // dropped from its response (no perItem entry) still get a ledger row with count 0;
          // acceptable: a mangled echo shouldn't re-queue the row forever.
          const ledger = batch.map((b) => ({
            hs_id: b.hsId,
            content_len: b.chunk.length,
            signal_count: perItem.get(b.hsId) ?? 0,
            model: AGENT_MODEL,
          }));
          const { error: ledErr } = await db.from("sdr_intel_scans").upsert(ledger, { onConflict: "hs_id" });
          if (ledErr) throw new Error(ledErr.message);
          scannedNow += batch.length;
        } catch (e) {
          errors++;
          console.warn("[signals] batch failed:", (e as Error).message);
        }
      }
    }

    if (scannedNow % 400 < BATCH && scannedNow > 0) console.log(`[signals] scanned ${scannedNow} · signals ${signalsFound}`);
    if (!rows || rows.length < PAGE || scannedNow >= cap) break;
  }

  console.log(`[signals] done — scanned ${scannedNow}, signals ${signalsFound}, errors ${errors}, model ${AGENT_MODEL}`);
  return { skipped: false, scanned: scannedNow, signals: signalsFound, errors };
}
