// Run via `npm run intel:signals` — the npm script passes `tsx --conditions=react-server` so the
// `server-only` guards resolve to their no-op exports. Extracts typed signals (objections,
// competitor mentions, buying signals, risks, commitments, timing) from new sdr_activity_content
// rows into sdr_intel_signals. Idempotent via the sdr_intel_scans ledger.
// Needs OPENAI_API_KEY + the Intelligence 2.0 migration. Cap per run: INTEL_SCAN_CAP (default 1200).
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { runSignalScan } from "../lib/intel/signals-run";

const limit = process.env.INTEL_SCAN_CAP ? Number(process.env.INTEL_SCAN_CAP) : undefined;

runSignalScan({ limit }).then((r) => {
  if (r.skipped) process.exit(0);
  process.exit(r.errors > 0 && r.scanned === 0 ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
