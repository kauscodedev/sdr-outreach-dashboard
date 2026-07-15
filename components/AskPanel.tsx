"use client";

/**
 * Ask-TrackerAI — the on-demand RAG Q&A surface (Intelligence hub, Ask tab). Question box +
 * server-enforced filter chips (date range / channel / scope) → POST /api/intel/ask → a
 * markdown-ish answer whose [S#] markers become citation chips; every citation links to the
 * evidence (account timeline drawer + the cited excerpt).
 */
import { FormEvent, useMemo, useRef, useState } from "react";
import { Sparkles, Send, Loader2, Phone, Mail, CalendarClock, ChevronDown, ChevronUp } from "lucide-react";
import { AskResponse, AskCitation } from "../lib/intel/types";
import { etDayStartMs } from "../lib/sync/buckets";
import { Surface, Segmented, cn } from "./ui";
import AccountTimeline from "./AccountTimeline";

const EXAMPLES = [
  "Which accounts mentioned pricing objections this month?",
  "What are the most common reasons dealers say no to us?",
  "Which competitors came up in calls recently, and on which accounts?",
  "Which accounts asked about integrations or their DMS?",
];

const PROGRESS_STAGES = [
  "Understanding the question…",
  "Searching call & email history…",
  "Cross-checking accounts and deals…",
  "Writing the grounded answer…",
];

function etDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", year: "numeric" });
}

/** Minimal renderer for the answer markdown: paragraphs, "- " bullets, **bold**, [S#] chips. */
function AnswerText({ text, onTag }: { text: string; onTag: (tag: string) => void }) {
  const lines = text.split("\n");
  const renderInline = (s: string, key: string) => {
    // Split on [S#] markers and **bold** spans, preserving both.
    const parts = s.split(/(\[S\d+\]|\*\*[^*]+\*\*)/g).filter(Boolean);
    return parts.map((p, i) => {
      const tag = p.match(/^\[(S\d+)\]$/)?.[1];
      if (tag) {
        return (
          <button key={`${key}-${i}`} onClick={() => onTag(tag)} title="Jump to the cited evidence"
            className="mx-0.5 inline-flex -translate-y-0.5 items-center rounded bg-primary-weak px-1 py-0 align-middle font-mono text-[10px] font-bold text-primary transition hover:bg-primary hover:text-primary-fg">
            {tag}
          </button>
        );
      }
      if (p.startsWith("**") && p.endsWith("**")) return <strong key={`${key}-${i}`} className="font-semibold text-ink">{p.slice(2, -2)}</strong>;
      return <span key={`${key}-${i}`}>{p}</span>;
    });
  };
  return (
    <div className="space-y-1.5 text-sm leading-relaxed text-ink-muted">
      {lines.map((ln, i) => {
        const t = ln.trim();
        if (!t) return null;
        const bullet = t.match(/^[-*]\s+(.*)$/) ?? t.match(/^\d+\.\s+(.*)$/);
        if (bullet) {
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
              <p>{renderInline(bullet[1], `l${i}`)}</p>
            </div>
          );
        }
        if (t.startsWith("#")) return <p key={i} className="pt-1 font-semibold text-ink">{t.replace(/^#+\s*/, "")}</p>;
        return <p key={i}>{renderInline(t, `l${i}`)}</p>;
      })}
    </div>
  );
}

export default function AskPanel({ scoped }: { scoped: boolean }) {
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<"mine" | "all">(scoped ? "mine" : "all");
  const [kind, setKind] = useState<"" | "call" | "email">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [askedQuestion, setAskedQuestion] = useState("");
  const [flashTag, setFlashTag] = useState<string | null>(null);
  const [showAllCitations, setShowAllCitations] = useState(false);
  const [timelineFor, setTimelineFor] = useState<{ id: string; name: string } | null>(null);
  const citationsRef = useRef<HTMLDivElement>(null);
  const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const filtersActive = useMemo(() => !!(kind || from || to), [kind, from, to]);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setAskedQuestion(text);
    setShowAllCitations(false);
    setStage(0);
    stageTimer.current = setInterval(() => setStage((s) => Math.min(s + 1, PROGRESS_STAGES.length - 1)), 4000);
    try {
      const res = await fetch("/api/intel/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: text,
          scope,
          filters: {
            kind: kind || null,
            afterMs: from ? etDayStartMs(from) : null,
            beforeMs: to ? etDayStartMs(to, 1) : null,
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? res.statusText);
      setResult(body as AskResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (stageTimer.current) clearInterval(stageTimer.current);
      setLoading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void ask(question);
  }

  function jumpToTag(tag: string) {
    setShowAllCitations(true);
    setFlashTag(tag);
    requestAnimationFrame(() => {
      citationsRef.current?.querySelector(`[data-tag="${tag}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    setTimeout(() => setFlashTag(null), 1600);
  }

  const citations = result?.citations ?? [];
  const shownCitations = showAllCitations ? citations : citations.slice(0, 4);

  return (
    <div className="space-y-4">
      <Surface className="p-4">
        <form onSubmit={onSubmit}>
          <div className="flex items-start gap-2">
            <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-fg">
              <Sparkles className="h-4 w-4" />
            </span>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(question); } }}
              rows={2}
              maxLength={500}
              placeholder="Ask anything about your prospects — objections, competitors, why an account went cold, what a dealer said…"
              className="min-h-[52px] flex-1 resize-y rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-subtle focus:ring-2 focus:ring-primary/30"
            />
            <button type="submit" disabled={loading || question.trim().length < 5}
              className="mt-1 inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-fg transition disabled:opacity-40">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Ask
            </button>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-11">
            {scoped && (
              <Segmented options={[["mine", "My reps"], ["all", "All reps"]]} value={scope} onChange={(v) => setScope(v as "mine" | "all")} />
            )}
            <Segmented options={[["", "Calls + emails"], ["call", "Calls"], ["email", "Emails"]]} value={kind} onChange={(v) => setKind(v as typeof kind)} />
            <div className={cn("flex items-center gap-1.5 rounded-xl border bg-surface px-2.5 py-1.5", filtersActive && (from || to) ? "border-primary/40" : "border-line")}>
              <CalendarClock className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-transparent text-xs text-ink-muted outline-none" aria-label="From date" />
              <span className="text-xs text-ink-subtle">→</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-transparent text-xs text-ink-muted outline-none" aria-label="To date" />
              {(from || to) && (
                <button type="button" onClick={() => { setFrom(""); setTo(""); }} className="text-[11px] font-semibold text-ink-subtle hover:text-ink">✕</button>
              )}
            </div>
            <span className="text-[11px] text-ink-subtle">Filters apply to every search the AI runs.</span>
          </div>
        </form>

        {!result && !loading && !error && (
          <div className="mt-3 flex flex-wrap gap-1.5 pl-11">
            {EXAMPLES.map((ex) => (
              <button key={ex} onClick={() => { setQuestion(ex); void ask(ex); }}
                className="rounded-full bg-surface-muted px-3 py-1 text-xs font-medium text-ink-muted transition hover:bg-primary-weak hover:text-primary">
                {ex}
              </button>
            ))}
          </div>
        )}
      </Surface>

      {loading && (
        <Surface className="p-4">
          <p className="flex items-center gap-2 text-sm text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin text-primary" /> {PROGRESS_STAGES[stage]}
            <span className="text-[11px] text-ink-subtle">(usually 10–25s — it reads your actual calls and emails)</span>
          </p>
        </Surface>
      )}
      {error && <Surface className="p-4"><p className="text-sm font-medium text-warn">⚠ {error}</p></Surface>}

      {result && (
        <Surface className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
            <p className="text-sm font-semibold text-ink">{askedQuestion}</p>
            <span className="text-[11px] tabular-nums text-ink-subtle">
              {result.searches} searches · {(result.ms / 1000).toFixed(1)}s · {result.citations.length} sources · {result.model}
            </span>
          </div>

          <AnswerText text={result.answer} onTag={jumpToTag} />

          {citations.length > 0 && (
            <div ref={citationsRef} className="mt-4 border-t border-line pt-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">Evidence ({citations.length})</div>
              <div className="space-y-1.5">
                {shownCitations.map((c: AskCitation) => (
                  <div key={c.tag} data-tag={c.tag}
                    className={cn("flex items-start gap-2 rounded-lg border px-2.5 py-1.5 transition", flashTag === c.tag ? "border-primary bg-primary-weak" : "border-line/70")}>
                    <span className="mt-0.5 rounded bg-surface-muted px-1 font-mono text-[10px] font-bold text-ink-muted">{c.tag}</span>
                    {c.kind === "call" ? <Phone className="mt-1 h-3 w-3 shrink-0 text-primary" /> : <Mail className="mt-1 h-3 w-3 shrink-0 text-cold" />}
                    <div className="min-w-0 flex-1 text-xs">
                      <div className="flex flex-wrap items-center gap-x-2">
                        {c.account_id ? (
                          <button onClick={() => setTimelineFor({ id: c.account_id!, name: c.account_name ?? c.account_id! })}
                            className="font-semibold text-ink hover:text-primary" title="Open account history">
                            {c.account_name ?? `Account ${c.account_id}`}
                          </button>
                        ) : <span className="font-semibold text-ink-subtle">Unattributed</span>}
                        <span className="font-mono text-[10px] tabular-nums text-ink-subtle">{etDate(c.ts_ms)}</span>
                      </div>
                      <p className="mt-0.5 truncate text-ink-subtle">&ldquo;{c.excerpt}&rdquo;</p>
                    </div>
                  </div>
                ))}
              </div>
              {citations.length > 4 && (
                <button onClick={() => setShowAllCitations((s) => !s)}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                  {showAllCitations ? <>Show fewer <ChevronUp className="h-3 w-3" /></> : <>Show all {citations.length} sources <ChevronDown className="h-3 w-3" /></>}
                </button>
              )}
            </div>
          )}
        </Surface>
      )}

      {timelineFor && <AccountTimeline account={timelineFor} onClose={() => setTimelineFor(null)} />}
    </div>
  );
}
