/**
 * SDR Daily Focus — GET /api/intel/focus?rep=<ownerId>. Merges agent watches + at-risk demos +
 * revival candidates for ONE rep (pure merge in lib/intel/focus.ts). Request-time assembly over
 * the stored snapshot + agent tables — no cron. Defaults to the viewer's own rep when their
 * scope is a single owner id.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSnapshot } from "../../../../lib/snapshot";
import { listWatches } from "../../../../lib/agent/store";
import { supabaseAdmin } from "../../../../lib/supabase/admin";
import { buildFocus, FocusActionState } from "../../../../lib/intel/focus";
import { FocusResponse, SignalLabel } from "../../../../lib/intel/types";
import { resolveViewer } from "../../../../lib/access/resolve";
import { supabaseServer } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

const SIGNAL_WINDOW_MS = 21 * 86_400_000;

export async function GET(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  const viewer = await resolveViewer(user?.email ?? "");

  const rep = req.nextUrl.searchParams.get("rep")
    ?? (viewer.defaultOwnerIds.length === 1 ? viewer.defaultOwnerIds[0] : null);
  if (!rep) return NextResponse.json({ error: "pass ?rep= (your scope spans multiple reps)" }, { status: 400 });

  const [snapshot, allWatches] = await Promise.all([getSnapshot(), listWatches()]);
  const repData = snapshot.reps[rep];
  if (!repData) return NextResponse.json({ error: "unknown rep" }, { status: 404 });

  const rooftops = (repData.book.units ?? []).flatMap((u) => u.rooftops);
  const watches = allWatches.filter((w) => w.repId === rep);

  // Shared action states + recent signals for the candidate accounts (both degrade to empty).
  const db = supabaseAdmin();
  const actions = new Map<string, FocusActionState>();
  const signalsByAccount = new Map<string, { label: SignalLabel; quote: string; tsMs: number | null }[]>();
  if (db) {
    const candidateIds = [...new Set([...watches.map((w) => w.accountId), ...rooftops.map((r) => r.id)])];
    const [actRes, sigRes] = await Promise.all([
      db.from("sdr_agent_actions").select("account_id,status,snoozed_until"),
      candidateIds.length
        ? db.from("sdr_intel_signals").select("account_id,label,quote,ts_ms")
            .in("account_id", candidateIds.slice(0, 800))
            .gte("ts_ms", Date.now() - SIGNAL_WINDOW_MS)
            .order("ts_ms", { ascending: false }).limit(300)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const a of (actRes.data ?? []) as { account_id: string; status: FocusActionState["status"]; snoozed_until: string | null }[]) {
      actions.set(a.account_id, { status: a.status, snoozedUntil: a.snoozed_until });
    }
    for (const s of (sigRes.data ?? []) as { account_id: string | null; label: SignalLabel; quote: string; ts_ms: number | null }[]) {
      if (!s.account_id) continue;
      const list = signalsByAccount.get(s.account_id) ?? [];
      list.push({ label: s.label, quote: s.quote, tsMs: s.ts_ms == null ? null : Number(s.ts_ms) });
      signalsByAccount.set(s.account_id, list);
    }
  }

  const items = buildFocus({ watches, rooftops, actions, signalsByAccount, nowMs: Date.now() });
  const res: FocusResponse = { repId: rep, repName: snapshot.owner_names[rep] ?? null, items };
  return NextResponse.json(res);
}
