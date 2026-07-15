/**
 * Shared action tracking — GET /api/agent/actions (list) · POST (merge one account's state, or
 * bulk-import legacy localStorage data). Replaces browser-only tracking so managers see
 * follow-through. Writes go through the service role; the actor's email is stamped server-side.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabase/admin";
import { supabaseServer } from "../../../../lib/supabase/server";
import { ActionStatus, ActionType, SharedAction } from "../../../../lib/intel/types";

export const dynamic = "force-dynamic";

const STATUSES: ActionStatus[] = ["not_started", "in_progress", "completed", "snoozed"];
const TYPES: ActionType[] = ["call", "email", "meeting", "note", "snoozed"];

interface ActionRow {
  account_id: string;
  status: ActionStatus;
  last_action_type: ActionType | null;
  last_action_at: string | null;
  snoozed_until: string | null;
  notes: { at: string; by: string | null; note: string }[];
  updated_by: string | null;
}

const rowToAction = (r: ActionRow): SharedAction => ({
  accountId: r.account_id,
  status: r.status,
  lastActionType: r.last_action_type,
  lastActionAt: r.last_action_at,
  snoozedUntil: r.snoozed_until,
  notes: Array.isArray(r.notes) ? r.notes : [],
  updatedBy: r.updated_by,
});

export async function GET() {
  const db = supabaseAdmin();
  if (!db) return NextResponse.json({ actions: [] });
  const { data, error } = await db.from("sdr_agent_actions").select("*");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ actions: ((data ?? []) as ActionRow[]).map(rowToAction) });
}

interface UpdateBody {
  accountId?: string;
  status?: ActionStatus;
  lastActionType?: ActionType | null;
  snoozedUntil?: string | null;
  note?: string;
  import?: {
    accountId: string;
    status: ActionStatus;
    lastActionAt: string | null;
    lastActionType: ActionType | null;
    snoozedUntil: string | null;
    notes: string[];
  }[];
}

export async function POST(req: NextRequest) {
  const db = supabaseAdmin();
  if (!db) return NextResponse.json({ error: "backend unavailable" }, { status: 503 });
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  const email = user?.email ?? null;

  let body: UpdateBody;
  try { body = (await req.json()) as UpdateBody; } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Bulk import from the legacy localStorage store: the newer last_action_at wins per account.
  if (Array.isArray(body.import)) {
    const { data: existing } = await db.from("sdr_agent_actions").select("account_id,last_action_at");
    const newest = new Map((existing ?? []).map((r) => [String(r.account_id), r.last_action_at as string | null]));
    const rows = body.import
      .filter((a) => a?.accountId && STATUSES.includes(a.status))
      .filter((a) => {
        const cur = newest.get(a.accountId);
        return !cur || (a.lastActionAt != null && a.lastActionAt > cur);
      })
      .map((a) => ({
        account_id: a.accountId,
        status: a.status,
        last_action_type: a.lastActionType && TYPES.includes(a.lastActionType) ? a.lastActionType : null,
        last_action_at: a.lastActionAt,
        snoozed_until: a.snoozedUntil,
        // Legacy notes are "ISO: text" strings — split back into structured entries.
        notes: (a.notes ?? []).slice(-20).map((n) => {
          const m = n.match(/^(\d{4}-\d{2}-\d{2}T[^:]+:[^:]+:[^:]+Z?): (.*)$/);
          return { at: m?.[1] ?? new Date(0).toISOString(), by: email, note: m?.[2] ?? n };
        }),
        updated_by: email,
        updated_at: new Date().toISOString(),
      }));
    if (rows.length) {
      const { error } = await db.from("sdr_agent_actions").upsert(rows, { onConflict: "account_id" });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ imported: rows.length });
  }

  const accountId = String(body.accountId ?? "").trim();
  if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });
  if (body.status && !STATUSES.includes(body.status)) return NextResponse.json({ error: "bad status" }, { status: 400 });
  if (body.lastActionType && !TYPES.includes(body.lastActionType)) return NextResponse.json({ error: "bad action type" }, { status: 400 });

  const { data: cur } = await db.from("sdr_agent_actions").select("*").eq("account_id", accountId).maybeSingle();
  const now = new Date().toISOString();
  const notes = Array.isArray((cur as ActionRow | null)?.notes) ? (cur as ActionRow).notes : [];
  if (body.note?.trim()) notes.push({ at: now, by: email, note: body.note.trim().slice(0, 500) });

  const row = {
    account_id: accountId,
    status: body.status ?? (cur as ActionRow | null)?.status ?? "not_started",
    last_action_type: body.lastActionType !== undefined ? body.lastActionType : (cur as ActionRow | null)?.last_action_type ?? null,
    last_action_at: body.status || body.note ? now : (cur as ActionRow | null)?.last_action_at ?? null,
    snoozed_until: body.snoozedUntil !== undefined ? body.snoozedUntil : (cur as ActionRow | null)?.snoozed_until ?? null,
    notes: notes.slice(-30),
    updated_by: email,
    updated_at: now,
  };
  const { error } = await db.from("sdr_agent_actions").upsert(row, { onConflict: "account_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ action: rowToAction(row as ActionRow) });
}
