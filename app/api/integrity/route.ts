/**
 * Data-integrity queue (blueprint §7.5, read-only v1) — GET /api/integrity
 *
 * Runs the pure checks (lib/integrity/checks.ts) over the full deal set + company lookup:
 * active orphan deals, slipped demos, stale actives (30d/60d), SDR-vs-account owner mismatches,
 * and ledger stage regressions. Findings carry deterministic suggested actions; rendered as the
 * triage queue on /admin. Auth: the global /api middleware gate.
 */
import { NextResponse } from "next/server";
import { loadDealsWithEvents, loadCompanyRefs } from "../../../lib/spine/store";
import { loadTeamStructure } from "../../../lib/team/load";
import { nameMap } from "../../../lib/team/helpers";
import { runIntegrityChecks, IntegrityKind } from "../../../lib/integrity/checks";

export const dynamic = "force-dynamic";

const LIST_CAP = 500;

export async function GET() {
  const [deals, companies, ts] = await Promise.all([
    loadDealsWithEvents(), loadCompanyRefs(), loadTeamStructure(),
  ]);
  const items = runIntegrityChecks(deals, companies, Date.now());
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;

  const names = nameMap(ts);
  return NextResponse.json({
    generated_at: new Date().toISOString(),
    total: items.length,
    counts: counts as Record<IntegrityKind, number>,
    items: items.slice(0, LIST_CAP).map((i) => ({
      ...i,
      owner_name: i.owner_id ? names[i.owner_id] ?? null : null,
    })),
    list_cap: LIST_CAP,
  });
}
