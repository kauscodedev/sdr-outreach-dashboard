/**
 * Ask-TrackerAI — on-demand RAG Q&A over the whole outreach corpus (Intelligence 2.0).
 * A tool-using loop (same machinery as briefs): the model resolves accounts, reads deal/watch
 * state, and runs filtered semantic searches; it finishes via submit_answer, whose args ARE the
 * structured output. Every factual claim carries an [S#] marker; the SERVER expands markers to
 * full citations from its tag→hit map (the model never reproduces activity ids — it would
 * mangle them). Request-level filters (date/kind/rep scope) are fixed server-side and applied
 * to every search; the model only chooses query text and an optional account pin.
 */
import "server-only";
import { supabaseAdmin } from "../supabase/admin";
import { runToolLoop, LoopTool } from "../agent/toolloop";
import { AGENT_MODEL, isConfigured } from "../agent/openai";
import { searchContentFiltered, FilteredHit } from "../agent/embeddings";
import { getBrief } from "../agent/briefs";
import { stageKey, stageLabel } from "../../config/deal-stages";
import { Viewer } from "../spine/types";
import { AskRequest, AskResponse, AskCitation } from "./types";

const MAX_QUESTION_CHARS = 500;
const SEARCH_BUDGET = 6; // filtered semantic searches per ask
const HITS_PER_SEARCH = 12;
const DEADLINE_MS = 45_000; // leave headroom inside the route's 60s maxDuration
const MAX_STEPS = 8;
const DAILY_ASK_CAP = 40; // per user, rolling 24h
const EXCERPT_CHARS = 200;

const etDay = (ms: number | null): string =>
  ms ? new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", year: "numeric" }) : "undated";

function systemPrompt(): string {
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "2-digit", year: "numeric" });
  return `You are TrackerAI's revenue-intelligence analyst for Spyne's outbound sales team (software sold to US auto dealerships; accounts are dealership "rooftops"). Today is ${today} (US/Eastern).

You answer questions from SDRs, AEs, and sales managers using TOOLS over the team's own call/email history, deal records, and account state. The searchable content covers roughly the last 90 days of calls and emails plus previously indexed history — say so plainly if a question needs older data.

Rules:
- Ground EVERY factual claim in tool results. Never invent accounts, quotes, dates, or numbers.
- Search results are tagged [S1], [S2], … Place the matching tag(s) in your answer right after each claim they support, e.g. "Three dealers pushed back on per-rooftop pricing [S2][S5]".
- Prefer 2-4 targeted searches with DIFFERENT phrasings over one broad search (e.g. for pricing objections also try "too expensive", "cost per rooftop", "budget concerns").
- For account-specific questions: find_account first, then account_overview, then pinned searches.
- Name accounts explicitly in the answer. Mention dates when they matter.
- If the question names a time period ("this month", "last week"), only claims whose search-result dates fall inside that period belong in the answer — exclude older hits even if relevant, or present them separately as prior history.
- If the evidence is thin, say what you looked for and what was missing — a grounded "not much" beats a confident guess.
- Keep answers tight: a short paragraph or bullets, written for a sales manager skimming between calls.
- Finish by calling submit_answer. Never answer in plain text.`;
}

const SUBMIT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The answer in markdown. Every factual claim carries its [S#] marker(s)." },
    cited_sources: { type: "array", items: { type: "string" }, description: "The [S#] tags actually relied on, e.g. [\"S1\",\"S4\"]." },
  },
  required: ["answer", "cited_sources"],
};

export type AskOutcome =
  | { ok: true; res: AskResponse }
  | { ok: false; status: number; error: string };

/** Rolling-24h rate limit — the ask log doubles as the limiter (no in-memory state). */
async function underDailyCap(email: string): Promise<boolean> {
  const db = supabaseAdmin();
  if (!db) return false;
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { count, error } = await db.from("sdr_intel_asks")
    .select("*", { count: "exact", head: true })
    .eq("email", email).gte("created_at", since);
  if (error) { console.warn("[ask] rate-limit check:", error.message); return true; } // fail open
  return (count ?? 0) < DAILY_ASK_CAP;
}

export async function askTrackerAI(req: AskRequest, viewer: Viewer): Promise<AskOutcome> {
  const db = supabaseAdmin();
  if (!db || !isConfigured()) return { ok: false, status: 503, error: "Intelligence backend not configured" };

  const question = (req.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  if (question.length < 5) return { ok: false, status: 400, error: "Ask a real question (5+ characters)" };
  if (!(await underDailyCap(viewer.email))) {
    return { ok: false, status: 429, error: `Daily limit reached (${DAILY_ASK_CAP} questions / 24h)` };
  }

  // Server-fixed search filters. Scope is a FOCUS default, not a security boundary (per RBAC
  // conventions): "mine" = the viewer's default reps; "all" or an org-wide viewer = no rep filter.
  const scopeAll = req.scope === "all" || viewer.defaultOwnerIds.length === 0;
  const ownerIds = req.filters?.ownerIds?.length
    ? req.filters.ownerIds
    : scopeAll ? null : viewer.defaultOwnerIds;
  const fixed = {
    ownerIds,
    kind: req.filters?.kind ?? null,
    afterMs: req.filters?.afterMs ?? null,
    beforeMs: req.filters?.beforeMs ?? null,
  };
  const pinnedAccount = req.filters?.accountId ?? null;

  const startedAt = Date.now();
  let searches = 0;
  let steps = 0;
  const hitByTag = new Map<string, FilteredHit>();
  const tagByHsId = new Map<string, string>(); // dedupe: same activity found twice keeps one tag

  const tools: LoopTool[] = [
    {
      name: "find_account",
      description: "Resolve a dealership/account NAME to its account id. Returns up to 5 candidate accounts (id, name). Use before account_overview or pinned searches when the user names an account.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "account name or fragment, e.g. 'Schepel'" } },
        required: ["name"],
      },
      run: async (args) => {
        const name = String(args.name ?? "").trim();
        if (!name) return "Provide a name fragment.";
        const { data, error } = await db.from("sdr_companies")
          .select("hs_id,name,owner_id,group_name").ilike("name", `%${name}%`).limit(5);
        if (error || !data?.length) return `No accounts matched "${name}".`;
        return data.map((c) => `id=${c.hs_id} · ${c.name}${c.group_name ? ` (group: ${c.group_name})` : ""}`).join("\n");
      },
    },
    {
      name: "account_overview",
      description: "Current state of ONE account: deals with stages/amounts, the agent's watch verdict, and the stored account brief. Use for 'why did X go cold / where does X stand' questions before searching.",
      parameters: {
        type: "object",
        properties: { account_id: { type: "string", description: "account id from find_account" } },
        required: ["account_id"],
      },
      run: async (args) => {
        const id = String(args.account_id ?? "").trim();
        if (!/^\d+$/.test(id)) return "Pass a numeric account id from find_account.";
        const [co, deals, watch, brief] = await Promise.all([
          db.from("sdr_companies").select("hs_id,name,owner_id,gd_stage,group_name").eq("hs_id", id).maybeSingle(),
          db.from("sdr_deals").select("hs_id,pipeline,dealstage,amount,demo_scheduled_for_ms").eq("company_id", id),
          db.from("sdr_agent_watches").select("status,reason,next_step,priority,last_signal_ms").eq("account_id", id).maybeSingle(),
          getBrief(id),
        ]);
        if (!co.data) return `No account with id ${id}.`;
        const lines: string[] = [`ACCOUNT: ${co.data.name} (id ${id})${co.data.group_name ? ` · group ${co.data.group_name}` : ""}${co.data.gd_stage ? ` · GD stage ${co.data.gd_stage}` : ""}`];
        const dl = (deals.data ?? []).map((d) => {
          const label = stageLabel(stageKey(d.pipeline, d.dealstage));
          const amt = d.amount != null ? ` · $${Number(d.amount).toLocaleString("en-US")}` : "";
          const demo = d.demo_scheduled_for_ms ? ` · demo ${etDay(Number(d.demo_scheduled_for_ms))}` : "";
          return `- deal at ${label}${amt}${demo}`;
        });
        lines.push(dl.length ? `DEALS:\n${dl.join("\n")}` : "DEALS: none on record");
        if (watch.data) lines.push(`AGENT WATCH: [${watch.data.status}] ${watch.data.reason ?? ""} · next: ${watch.data.next_step ?? "—"} · last signal ${etDay(watch.data.last_signal_ms ? Number(watch.data.last_signal_ms) : null)}`);
        if (brief) lines.push(`STORED BRIEF (${etDay(brief.generatedAt ? Date.parse(brief.generatedAt) : null)}): ${brief.summary} · next: ${brief.nextStep}`);
        return lines.join("\n");
      },
    },
    {
      name: "search_content",
      description: "Semantic search over the team's call/email content (notes, AI call summaries, transcript excerpts, email bodies). Returns dated, tagged excerpts. Optionally pin to one account_id. Use DIFFERENT phrasings across searches.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "what to look for, e.g. 'pricing objection'" },
          account_id: { type: "string", description: "optional: restrict to one account (id from find_account)" },
        },
        required: ["query"],
      },
      run: async (args) => {
        if (++searches > SEARCH_BUDGET) return "Search budget exhausted — call submit_answer NOW with what you have.";
        const accountId = String(args.account_id ?? "").trim() || pinnedAccount;
        const hits = await searchContentFiltered(String(args.query ?? ""), { ...fixed, accountId: accountId || null }, HITS_PER_SEARCH);
        if (!hits.length) return "No content matched this query within the active filters. Try a DIFFERENT phrasing or angle — or submit with what you have.";
        return hits.map((h) => {
          let tag = tagByHsId.get(h.hs_id);
          if (!tag) {
            tag = `S${hitByTag.size + 1}`;
            hitByTag.set(tag, h);
            tagByHsId.set(h.hs_id, tag);
          }
          return `[${tag}] (${h.kind ?? "?"} · ${etDay(h.ts_ms)} · account ${h.account_id ?? "?"} · sim ${h.similarity.toFixed(2)}) ${h.chunk}`;
        }).join("\n---\n");
      },
    },
  ];

  let raw: Record<string, unknown> | null = null;
  try {
    raw = await runToolLoop({
      system: systemPrompt(),
      user: `QUESTION: ${question}${fixed.afterMs || fixed.beforeMs || fixed.kind || fixed.ownerIds ? `\n(Active filters: ${[fixed.afterMs ? `after ${etDay(fixed.afterMs)}` : null, fixed.beforeMs ? `before ${etDay(fixed.beforeMs)}` : null, fixed.kind ? `${fixed.kind}s only` : null, fixed.ownerIds ? `${fixed.ownerIds.length} rep(s)` : null].filter(Boolean).join(", ")} — applied to every search automatically.)` : ""}`,
      tools,
      submit: { name: "submit_answer", description: "Submit the final grounded answer with its [S#] citations.", parameters: SUBMIT_SCHEMA },
      maxSteps: MAX_STEPS,
      deadlineMs: DEADLINE_MS,
    });
    steps = MAX_STEPS; // runToolLoop doesn't expose the count; log the cap as an upper bound
  } catch (e) {
    console.warn("[ask] tool loop failed:", (e as Error).message);
  }

  const answer = typeof raw?.answer === "string" ? raw.answer.trim() : "";
  if (!answer) {
    return { ok: false, status: 504, error: "Couldn't finish within the time budget — try a narrower question (add an account name, a shorter date range, or fewer topics)." };
  }

  // Expand the tags the model actually cited (fall back to every tag mentioned in the text).
  const citedTags = Array.isArray(raw?.cited_sources)
    ? (raw!.cited_sources as unknown[]).map((t) => String(t).replace(/[[\]]/g, "").trim()).filter(Boolean)
    : [];
  const inText = [...answer.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]);
  const tags = [...new Set([...citedTags, ...inText])].filter((t) => hitByTag.has(t));

  // Resolve account names for the citations in one read.
  const accountIds = [...new Set(tags.map((t) => hitByTag.get(t)!.account_id).filter(Boolean))] as string[];
  const names = new Map<string, string | null>();
  if (accountIds.length) {
    const { data } = await db.from("sdr_companies").select("hs_id,name").in("hs_id", accountIds);
    for (const c of data ?? []) names.set(String(c.hs_id), c.name ?? null);
  }

  const citations: AskCitation[] = tags.map((tag) => {
    const h = hitByTag.get(tag)!;
    return {
      tag,
      hs_id: h.hs_id,
      account_id: h.account_id,
      account_name: h.account_id ? (names.get(h.account_id) ?? null) : null,
      ts_ms: h.ts_ms,
      kind: h.kind,
      excerpt: h.chunk.slice(0, EXCERPT_CHARS),
    };
  });
  const accounts = accountIds.map((id) => ({ id, name: names.get(id) ?? null }));

  const res: AskResponse = {
    answer,
    citations,
    accounts,
    searches,
    steps,
    ms: Date.now() - startedAt,
    model: AGENT_MODEL,
  };

  // Audit log (also the rate-limiter's data). Failure to log never fails the ask.
  const { error: logErr } = await db.from("sdr_intel_asks").insert({
    email: viewer.email, question, answer: res as unknown as Record<string, unknown>,
    steps: res.steps, searches: res.searches, ms: res.ms, model: res.model,
  });
  if (logErr) console.warn("[ask] log:", logErr.message);

  return { ok: true, res };
}
