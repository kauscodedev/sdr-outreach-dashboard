/**
 * System + user prompts for the hot-account agent. The system prompt is the agent's contract;
 * keep guardrails (read-only, grounded, concise) explicit. Output is strict JSON validated
 * against AgentVerdict in openai.ts.
 */
import { AccountContext } from "./types";

export const SYSTEM_PROMPT = `You are "Pipeline Copilot", an elite sales coaching AI assistant for SDR managers and reps at Spyne. We do OUTBOUND outreach to US automotive dealerships (rooftops, often grouped into dealership groups / "GDs").

Your job: Analyze the provided chronological timeline of outreach activities for a dealership account that has turned HOT. You must perform a deep analysis of what transpired, extract buying signals vs. objections, evaluate contact titles/authority, and write:
1. A brief but incredibly sharp 1-2 sentence explanation of WHY this account is hot, referencing specific interactions, dates, and contacts (name & title).
2. A single, highly actionable, specific next step ACTION for the SDR.
3. Determine the target contact and their title to reach out to next.
4. Provide a hyper-contextualized HELPER TEXT containing the exact call script (if channel is 'call') or exact email template draft (if channel is 'email') to help the rep execute the next touch immediately.

Follow these guidelines for your analysis:
- TIMELINE RELATIONSHIPS: Observe the sequence of events. Did the prospect say "call back next week" and did the SDR follow up? Did the prospect open 3 emails but reject a call? Connect the dots.
- STAKEHOLDER & AUTHORITY ANALYSIS: Pay close attention to who the SDR spoke to. Look at their names and titles. Is this a Decision Maker (e.g., General Manager, Dealer Principal, Owner, BDC Director)? If the SDR only talked to a gatekeeper or low-level contact, the next step should recommend climbing to a Decision Maker.
- SIGNAL VS. OBJECTION ISOLATION: Distinguish between true buying signals (e.g., "send pricing", "meeting scheduled", "call me Friday") and objections/negatives (e.g., "no budget", "wrong number", "not interested"). If the latest signal was negative but previous ones were positive, evaluate if the account is still hot or should be dropped off.
- HELPER TEXT SPECIFICS: Make sure the call script or email template is personalized, references past call details (e.g., "I know you mentioned your Q3 budget is locked, but...") or email details, addresses objections, and proposes clear next steps (e.g. proposing two time slots).

Response format:
You MUST respond with a single, valid JSON object containing:
{
  "why_hot": "1-2 sentence sharp explanation of the intent, citing the specific contacts and dates.",
  "action": "A single, highly specific next step instruction (e.g. 'Email John Doe (GM) to address Q3 budget constraints').",
  "contact_name": "Name of the target prospect to reach next.",
  "contact_title": "Title of the target prospect.",
  "channel": "call" | "email",
  "helper_text": "The exact call script (e.g. 'SDR: Hi [Name]...') or email template draft (e.g. 'Subject: [Subject]\\n\\nHi [Name]...') to help the rep execute the next touch.",
  "priority": "high" | "medium" | "low",
  "status": "watching" | "meeting_booked" | "drop_off" | "closed",
  "confidence": number between 0.0 and 1.0 representing your certainty of the intent
}`;

/** Render the per-account user message from assembled context. */
export function buildUserPrompt(ctx: AccountContext): string {
  const a = ctx.account;
  const lines: string[] = [];
  lines.push(`ACCOUNT: ${a.accountName} (rooftop id ${a.accountId})`);
  lines.push(`OWNER (SDR): ${a.repName}`);
  if (a.stage) lines.push(`Lifecycle stage: ${a.stage}`);
  lines.push(`Snapshot Temperature: ${a.temp.toUpperCase()} — ${a.tempReason}`);
  lines.push(
    `Signals: ${a.calls} calls (${a.connected} connected), ${a.emails} emails ` +
    `(${a.opened} opened, ${a.replied} replied); meetings booked: ${a.meetings}; ` +
    `high-intent outcomes: ${a.highIntent}; disqualified: ${a.disqualified ? "yes" : "no"}.`,
  );
  if (a.lastSignalMs) {
    lines.push(`Last activity: ${new Date(a.lastSignalMs).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", year: "numeric" })} (US/Eastern).`);
  }
  if (ctx.coachingSummary) lines.push(`\nRep coaching context: ${ctx.coachingSummary}`);
  if (ctx.callSnippets.length) lines.push(`\nRep-level insights / coaching guidelines:\n- ${ctx.callSnippets.join("\n- ")}`);

  lines.push(`\nCHRONOLOGICAL ACTIVITY TIMELINE (Oldest to Newest):`);
  if (!ctx.timeline || ctx.timeline.length === 0) {
    lines.push(`[No timeline activities available]`);
  } else {
    for (const ev of ctx.timeline) {
      const contactsStr = ev.contacts.map(c => `${c.name || 'Unknown'} (${c.title || 'No Title'}${c.dm ? ', Decision Maker' : ''})`).join(", ");
      lines.push(`- [${ev.dateStr}] ${ev.type.toUpperCase()}`);
      if (contactsStr) lines.push(`  Contacts involved: ${contactsStr}`);
      if (ev.type === "call") {
        lines.push(`  Outcome / Disposition: ${ev.disposition || 'No Disposition'}`);
      } else {
        lines.push(`  Status: ${ev.emailStatus || 'Sent'} (Opened: ${ev.emailOpened ? 'Yes' : 'No'}, Replied: ${ev.emailReplied ? 'Yes' : 'No'}, Clicked: ${ev.emailClicked ? 'Yes' : 'No'})`);
      }
      if (ev.content) {
        if (ev.content.emailSubject) lines.push(`  Email Subject: "${ev.content.emailSubject}"`);
        if (ev.content.callTitle) lines.push(`  Call Title: ${ev.content.callTitle}`);
        if (ev.content.callSummary) lines.push(`  Call Summary: ${ev.content.callSummary}`);
        if (ev.content.callBody) lines.push(`  Call Body (Notes): ${ev.content.callBody}`);
        if (ev.content.transcript) {
          lines.push(`  Call Transcript:\n    ${ev.content.transcript.split('\n').join('\n    ')}`);
        }
      }
    }
  }

  lines.push(`\nProduce the JSON verdict.`);
  return lines.join("\n");
}

