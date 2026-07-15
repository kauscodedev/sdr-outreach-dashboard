/**
 * Ask-TrackerAI — POST /api/intel/ask  { question, scope?, filters? } → AskResponse.
 * On-demand RAG Q&A over the outreach corpus (tool loop + filtered pgvector search).
 * Auth: the global middleware gates /api/*; the viewer's scope defaults the rep filter.
 */
import { NextRequest, NextResponse } from "next/server";
import { askTrackerAI } from "../../../../lib/intel/ask";
import { AskRequest } from "../../../../lib/intel/types";
import { resolveViewer } from "../../../../lib/access/resolve";
import { supabaseServer } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // the tool loop's internal deadline is 45s

export async function POST(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  if (!user?.email) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const viewer = await resolveViewer(user.email);

  let body: AskRequest;
  try {
    body = (await req.json()) as AskRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const outcome = await askTrackerAI(body, viewer);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  return NextResponse.json(outcome.res);
}
