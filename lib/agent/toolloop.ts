/**
 * Generic tool-using agent loop (blueprint §7.3) — agentic RAG instead of one stuffed prompt.
 * The model gets read tools and MUST finish by calling the designated submit tool, whose
 * arguments ARE the structured output (function-calling as schema enforcement — no JSON-mode
 * juggling alongside tools). Read-only by construction: tools only fetch.
 */
import "server-only";
import { chatStep, ChatMessage, ChatToolDef } from "./openai";

export interface LoopTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema for the arguments
  run: (args: Record<string, unknown>) => Promise<string>;
}

const TOOL_OUTPUT_CAP = 6000; // chars per tool result fed back to the model

/**
 * Run the loop: alternate model ↔ tools until the submit tool is called (its args are returned)
 * or maxSteps is exhausted (null → caller falls back to single-shot).
 */
export async function runToolLoop(opts: {
  system: string;
  user: string;
  tools: LoopTool[]; // read tools — the submit tool is declared separately
  submit: { name: string; description: string; parameters: Record<string, unknown> };
  maxSteps?: number;
  /** Wall-clock budget (ms). Once exceeded, the model is told to submit immediately — used by
   *  request-time callers (Ask) that must finish inside a serverless maxDuration. */
  deadlineMs?: number;
}): Promise<Record<string, unknown> | null> {
  const { system, user, tools, submit } = opts;
  const maxSteps = opts.maxSteps ?? 8;
  const startedAt = Date.now();
  const pastDeadline = () => opts.deadlineMs != null && Date.now() - startedAt > opts.deadlineMs;
  let deadlineNudged = false;

  const toolDefs: ChatToolDef[] = [
    ...tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    { type: "function" as const, function: { name: submit.name, description: submit.description, parameters: submit.parameters } },
  ];

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const msg = await chatStep(messages, toolDefs);
    messages.push(msg as ChatMessage);

    if (!msg.tool_calls?.length) {
      // The model chatted instead of finishing — nudge it once toward the submit tool.
      messages.push({ role: "user", content: `Finish now by calling ${submit.name} with the complete result.` });
      continue;
    }

    for (const tc of msg.tool_calls) {
      if (tc.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* leave empty */ }

      if (tc.function.name === submit.name) return args; // done — args ARE the output

      const tool = tools.find((t) => t.name === tc.function.name);
      let out: string;
      try {
        out = tool ? await tool.run(args) : `Unknown tool: ${tc.function.name}`;
      } catch (e) {
        out = `Tool error: ${(e as Error).message}`;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: out.slice(0, TOOL_OUTPUT_CAP) });
    }

    if (pastDeadline() && !deadlineNudged) {
      deadlineNudged = true;
      messages.push({ role: "user", content: `Time budget exhausted — call ${submit.name} NOW with your best result from what you already have. Do not call any other tool.` });
    }
  }
  return null; // budget exhausted without a submit — caller falls back
}
