/**
 * Themes read path (manager view): what prospects keep saying, aggregated from the mined
 * signals. Request-time RPC group-bys (sdr_intel_themes / sdr_intel_theme_trend) — volume is
 * ~1k signals/day, no materialized rollup needed. Examples carry verbatim quotes with account
 * attribution so every number can be opened to its evidence.
 */
import "server-only";
import { supabaseAdmin } from "../supabase/admin";
import { loadCompanyNamesFor } from "../spine/store";
import { SignalLabel, ThemeRow, ThemeTrendPoint, ThemeExample } from "./types";

const EXAMPLE_FETCH = 120; // recent signals fetched to pick examples from
const EXAMPLES_PER_THEME = 3;
const TOP_THEMES_FOR_EXAMPLES = 6;

export interface ThemesData {
  themes: ThemeRow[];
  trend: ThemeTrendPoint[];
  examples: ThemeExample[];
}

export async function loadThemes(opts: {
  fromMs: number;
  toMs: number;
  trendLabel: SignalLabel;
  ownerIds: string[] | null;
}): Promise<ThemesData> {
  const db = supabaseAdmin();
  if (!db) return { themes: [], trend: [], examples: [] };
  const owners = opts.ownerIds?.length ? opts.ownerIds : null;

  const [themesRes, trendRes] = await Promise.all([
    db.rpc("sdr_intel_themes", { p_after_ms: opts.fromMs, p_before_ms: opts.toMs, p_owner_ids: owners }),
    db.rpc("sdr_intel_theme_trend", { p_after_ms: opts.fromMs, p_before_ms: opts.toMs, p_label: opts.trendLabel, p_owner_ids: owners }),
  ]);
  if (themesRes.error) console.warn("[themes] rpc:", themesRes.error.message);
  if (trendRes.error) console.warn("[themes] trend rpc:", trendRes.error.message);

  const themes: ThemeRow[] = ((themesRes.data ?? []) as ThemeRow[]).map((t) => ({
    ...t, mentions: Number(t.mentions), accounts: Number(t.accounts), reps: Number(t.reps),
  }));
  const trend: ThemeTrendPoint[] = ((trendRes.data ?? []) as ThemeTrendPoint[]).map((t) => ({
    ...t, mentions: Number(t.mentions),
  }));

  // Examples: recent quotes for the top themes (one range read, grouped in memory).
  let q = db.from("sdr_intel_signals")
    .select("label,category,quote,account_id,ts_ms")
    .gte("ts_ms", opts.fromMs).lt("ts_ms", opts.toMs)
    .order("ts_ms", { ascending: false }).limit(EXAMPLE_FETCH);
  if (owners) q = q.in("owner_id", owners);
  const { data: sigRows, error: sigErr } = await q;
  if (sigErr) console.warn("[themes] examples:", sigErr.message);

  const topKeys = new Set(themes.slice(0, TOP_THEMES_FOR_EXAMPLES).map((t) => `${t.label}·${t.category}`));
  const picked: ThemeExample[] = [];
  const perTheme = new Map<string, number>();
  for (const r of (sigRows ?? []) as { label: SignalLabel; category: string | null; quote: string; account_id: string | null; ts_ms: number | null }[]) {
    const key = `${r.label}·${r.category ?? "(uncategorized)"}`;
    if (!topKeys.has(key)) continue;
    const n = perTheme.get(key) ?? 0;
    if (n >= EXAMPLES_PER_THEME) continue;
    perTheme.set(key, n + 1);
    picked.push({
      label: r.label, category: r.category, quote: r.quote,
      accountId: r.account_id, accountName: null,
      tsMs: r.ts_ms == null ? null : Number(r.ts_ms),
    });
  }

  const names = await loadCompanyNamesFor([...new Set(picked.map((e) => e.accountId).filter(Boolean))] as string[]);
  for (const e of picked) if (e.accountId) e.accountName = names[e.accountId] ?? null;

  return { themes, trend, examples: picked };
}
