/**
 * Rebuild the snapshot row from the spine WITHOUT a HubSpot pull (spine-only). Handy after an
 * aggregate change, or to recover from a saveSnapshot failure without waiting for the delta.
 * Run: npm run sync:reaggregate
 */
import { config } from "dotenv";
config();
config({ path: ".env.local" });

async function main() {
  const { reaggregate } = await import("../lib/spine/runner");
  console.log("[reaggregate] rebuilding snapshot from the spine…");
  const totals = await reaggregate({ calls: true, emails: true }, true);
  console.log("[reaggregate] done:", totals);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[reaggregate] failed:", e); process.exit(1); });
