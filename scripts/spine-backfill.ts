// Run via `npm run sync:backfill` — the npm script passes `tsx --conditions=react-server` so the `server-only` guard in lib/supabase/admin.ts resolves to its no-op export.
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { runBackfill } from "../lib/spine/runner";
// Reuse the same preflight semantics as scripts/sync.ts (calls/emails caps).
import { hubspotGet } from "../lib/hubspot/client";

async function cap(obj: string, prop: string, expect: string) {
  try {
    const d = await hubspotGet<{ options?: { value: string }[] }>(`/crm/v3/properties/${obj}/${prop}`);
    return (d.options ?? []).some((o) => o.value === expect);
  } catch {
    return false;
  }
}

(async () => {
  const caps = {
    calls: await cap("calls", "hs_call_direction", "OUTBOUND"),
    emails: await cap("emails", "hs_email_direction", "EMAIL"),
  };
  if (!caps.calls && !caps.emails) throw new Error("token can read neither calls nor emails");
  await runBackfill(caps);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
