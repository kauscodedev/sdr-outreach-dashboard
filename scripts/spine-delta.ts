// Run via `npm run sync:delta` — the npm script passes `tsx --conditions=react-server` so the `server-only` guard in lib/supabase/admin.ts resolves to its no-op export.
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { runDelta } from "../lib/spine/runner";

runDelta().catch((e) => {
  console.error(e);
  process.exit(1);
});
