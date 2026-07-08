# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An SDR outbound-outreach dashboard for sales leadership. It started as a **coverage** tool
(*are all accounts being tapped?*) and now layers **intelligence** on top:

- **Coverage/quality** — per rep and per US/Eastern window: unique contacts/companies touched,
  depth, call-outcome + email breakdown, cumulative owned-book coverage, a composite quality score.
- **Account temperature (v2)** — hot/warm/cold from call *outcomes* + engagement, with a
  recency-aware "disqualified" rule (`lib/sync/temperature.ts`).
- **Monthly new-vs-existing** — per rep, how many rooftops/contacts were worked this month and how
  many are brand new (first ever worked that month) — `RepData.monthly`.
- **Hot-account AI agent** — an OpenAI copilot that watches hot accounts and produces a grounded
  "why hot + next step" task list at `/attention` (`lib/agent/*`). HubSpot read-only.

Read `README.md` for product definitions and setup. This file covers architecture and the
non-obvious conventions that span multiple files.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the dashboard locally (http://localhost:3000) |
| `npm run build` | Production build — also runs the TypeScript typecheck (there is no separate `tsc` script) |
| `npm run lint` | ESLint (`next/core-web-vitals`) |
| `npm test` | Run all Vitest unit tests (`vitest run`) |
| `npm run verify:schema` | Probe that `supabase/sdr_schema.sql` is applied (tables reachable, seeds present, anon blocked) |
| `npm run sync:backfill` | One-time full pull → Postgres spine (~1 h; run before the first delta, and after adding reps to `config/reps.ts`) |
| `npm run sync:delta` | Incremental sync: pull `hs_lastmodifieddate > watermark`, upsert, re-aggregate (O(changes)) |
| `npm run sync:reconcile` | Nightly drift heal: full owned-book re-pull + 7-day activity re-pull |
| `npm run sync:reaggregate` | Rebuild the snapshot from the spine **without a HubSpot pull** (recover from a saveSnapshot failure; prints snapshot size) |
| `npm run agent:run` | One hot-account agent pass (OpenAI reasoning → `sdr_agent_watches`); needs `OPENAI_API_KEY` |
| `npm run content:backfill` | **Opt-in** pull of call notes/transcripts/email subjects → `sdr_activity_content` (kept OFF the delta path) |
| `npm run sync` | **Legacy** file-snapshot pull → `data/snapshot.json` (pre-spine; retired) |

All non-`dev`/`build`/`lint`/`test` scripts run via `tsx --conditions=react-server` — required so
the `server-only` guard in `lib/supabase/admin.ts` resolves to a no-op under plain Node. Scripts
load env from `.env` then `.env.local` (so put local secrets, incl. `OPENAI_API_KEY`, in `.env.local`).

Run a **single test**: `npx vitest run tests/temperature.test.ts` (add `-t "name"` to filter by
test name; drop `run` for watch mode). Tests (`tests/`) cover only pure logic: US/Eastern bucketing
(`buckets.test.ts`, incl. DST cases), aggregation incl. GD book units + owner≠doer + monthly
(`aggregate.test.ts`), the temperature classifier (`temperature.test.ts`), call-quality mappers
(`callquality.test.ts`), spine row mappers (`spine-rows.test.ts`), the RBAC scope decision
(`access.test.ts`), the agent detector (`agent-detect.test.ts`), and the auth-domain rule
(`auth-domain.test.ts`). Never import a `server-only`-guarded module (`lib/supabase/admin.ts`,
`lib/callquality/fetch.ts`, `lib/agent/openai|store|runner.ts`) from a test — it throws under vitest.

Node 22+ required (`engines.node`; workflows pin `node-version: 22`). Hard floor:
`@supabase/supabase-js` needs a global `WebSocket` (Node 21+); on Node 20 every `supabaseAdmin()`
throws "native WebSocket not found". Import alias `@/*` maps to the repo root (`tsconfig.json`).

## Architecture: change-feed spine → Postgres → snapshot row, behind an auth gate

Two data sources, one gate. **The app never calls HubSpot at request time.** Outreach data lives in
a Postgres "data spine" (`sdr_*` tables in the call-scoring project's Supabase, beside — never
touching — call-scoring's own tables), kept current by an O(changes) delta sync. Call-quality data
is read **live** from the same Supabase at request time. Every route sits behind Supabase Google
SSO (spyne.ai only), and login → owner → AE-pod/manager resolves a per-viewer default scope.

```
scripts/spine-{backfill,delta,reconcile}.ts · reaggregate.ts   (GitHub Actions cron — NOT on Vercel)
  └─ lib/spine/runner.ts   orchestration (watermark-driven, advisory-locked, idempotent)
       ├─ lib/sync/pull.ts        pullChangedActivities / pullChangedCompanies (hs_lastmodifieddate > watermark)
       ├─ lib/sync/associate.ts   resolve activity → contact → company (v4 batch reads)
       ├─ lib/spine/store.ts      batched upserts into sdr_activities/companies/contacts/owners; saveSnapshot()
       └─ lib/sync/aggregate.ts   rebuild the Snapshot: reach, temperature (lib/sync/temperature.ts),
                                   owner-attributed coverage, monthly new-unique, quality, insights
             ↓  saveSnapshot()  (sdr_save_snapshot RPC, else retrying upsert)
  sdr_snapshots (one jsonb row, id=1)   ← the delta writes this; getSnapshot reads it first
             ↓
  lib/snapshot.ts   getSnapshot: loadFromSpine → loadFromBlob → loadFromFile → empty  (+ stripBookUnits)
             ↓
  middleware.ts  ── auth gate (session + @spyne.ai domain) ── app/login, app/auth/callback
             ↓
  app/page.tsx   resolveViewer(email) + snapshot (units stripped)  → components/Dashboard.tsx
  app/admin      roles CRUD + team-structure view + sync health   (admin/leadership only)
  app/attention  hot-account task list (AttentionBoard) ← sdr_agent_watches
  app/api/rep/[ownerId]/book|calls   lazy per-rep drill-downs   ·   app/api/agent/watches
  app/api/sync/delta   CRON_SECRET-gated alt trigger for runDelta

scripts/agent-run.ts  (.github/workflows/spine-agent.yml, every 2 h)
  └─ lib/agent/runner.ts  runAgent: hot accounts (snapshot) → detect.ts → OpenAI (openai.ts) → sdr_agent_watches/notes
```

The heavy pull runs **outside Vercel** (a sync exceeds serverless limits): delta every 15 min
(`spine-delta.yml`), reconcile nightly (`spine-reconcile.yml`), agent every 2 h (`spine-agent.yml`).
Shared contracts: `lib/sync/types.ts` (sync↔UI), `lib/spine/types.ts` (`sdr_*` rows + `Viewer`),
`lib/callquality/types.ts` (read-only call-scoring), `lib/agent/types.ts` (agent I/O).

### Data model
`Snapshot` → `reps[ownerId]` → `{ periods[periodKey]: PeriodMetrics, daily[], book, monthly[] }`.
Six US/Eastern periods (`today`…`this_month`). `PeriodMetrics` bundles volume, reach-by-channel,
DM reach, `temp` (AccountTemp counts), and quality. The three **narrow periods** (`today`,
`yesterday`, `this_week`) also carry `company_breakdown` (per-account rows with enriched contact
lists) — others omit it to keep the snapshot small. `RepData.book` (`BookCoverage`) is **cumulative,
period-independent**; `book.units` is the GD → rooftop → contacts Book-Explorer drill-down (heavy —
stripped from the page, lazy-loaded via `/book`). `RepData.monthly` is the last 3 ET months of
new-vs-existing tapped rooftops/contacts.

## Conventions & gotchas (the load-bearing rules)

- **Snapshot size is a hard constraint.** `sdr_snapshots` is ONE jsonb row (~6 MB with 30 reps ×
  thousands of owned rooftops). The plain upsert intermittently trips Postgres `statement_timeout`.
  Mitigations: `ROOFTOP_CONTACT_CAP` (12) in `aggregate.ts` bounds contacts per rooftop;
  `saveSnapshot` prefers the `sdr_save_snapshot(jsonb)` RPC (`SET LOCAL statement_timeout`) and
  falls back to a **retrying** upsert. If aggregate changes enlarge the snapshot, watch for the
  timeout and recover with `npm run sync:reaggregate` (spine-only; logs the size). A failed write
  leaves the last good row intact.
- **Coverage is attributed to the account's OWNER, not the activity doer** (`aggregate.ts`,
  `companyOwner` map). An owned account is "tapped" — and its rooftop/contact engagement rolls up to
  the owner's book — whenever ANY tracked SDR works it. Per-rep **period** metrics (touches, reach,
  daily) stay per activity-doer.
- **Temperature is outcome-driven (`lib/sync/temperature.ts`, `classifyTemperature`).** Pure
  classifier over per-account signal counts (built in `aggregate.ts` from the raw disposition GUID
  on every `sdr_activities` row via `config/dispositions.ts` categories). Rules, first match wins:
  HOT (meeting scheduled/rescheduled, callback-high, callback-low ×2, email reply); WARM (referral,
  callback-low ×1, any connect, email open); COLD (no-connect / untouched / **disqualified**). A
  connected-but-negative outcome (Not Interested, Not a Right POC, bad/wrong number, left org) pulls
  the account to cold — **unless a more recent positive signal revives it** (recency via
  `lastPositiveMs`/`lastNegativeMs`). Same engine runs per account, per owned rooftop, and per contact.
- **"Connected" is a business rule, not `hs_call_status`.** Only the 11 GUIDs in
  `config/dispositions.ts` `CONNECTED_DISPOSITIONS` count as reaching a human. Ported verbatim from
  `call-scoring-agent/config/dispositions.py`; keep in sync. `connect_rate` excludes null-disposition
  calls from the denominator.
- **`config/reps.ts` is the single source of truth** for which owner IDs appear (30 SDRs) and is the
  `IN` filter for HubSpot searches. Adding a rep needs a `sync:backfill`/`reconcile` to pull their
  history (a delta only catches recently-modified rows).
- **RBAC is a 3-level focus model in `config/team-structure.ts`** (NOT HubSpot teams). SDR → AE pod
  → Manager, keyed by owner id; some SDRs are player-coach managers/TLs (TLs roll up to a parent
  manager). `decideScope` (`lib/access/scope.ts`, pure, unit-tested): admin/leadership → all; AE pod
  lead by login email → the pod's SDRs; manager/TL by owner id → their subtree + self; individual
  SDR → own book; else org-wide viewer. **Focus model, not confidentiality** — everyone keeps the
  "All reps" toggle; `resolveViewer` never throws (degrades to org-wide). `sdr_roles` (DB) still
  holds admin/leadership overrides; its HubSpot-team columns are vestigial.
- **Snapshot loader must use a static `import()`, not `fs`** (`lib/snapshot.ts`) — a runtime path is
  missed by Vercel output-file-tracing.
- **The 10k Search ceiling** — legacy full pull slices into 7-day windows; delta pulls cut each
  modified-window at 9,800 and resume from `lastmodified − 1` (callers dedupe), at most
  `MAX_RESUME_WINDOWS` (3) per run, deferring the rest (watermark still advances — no livelock).
- **Sync degrades gracefully on 403** — `preflightCaps()` probes calls/emails independently, returns
  false only on a 403 scope error; the dropped type is recorded in the snapshot's `sources`. Emails
  need the `connected-email-data-access` scope.
- **Change-feed sync is watermark-driven + idempotent** — per-type watermarks in `sdr_sync_state`;
  each delta re-reads from `watermark − OVERLAP_MS` (5 min) and advances only after upserts +
  re-aggregate succeed (all upserts PK-idempotent). One run at a time via an advisory lock (the
  `lock` row), fenced by a lease token. Owner-moves-away are corrected by the nightly reconcile;
  HubSpot deletions are not propagated (accepted gap).
- **Secrets live only in `.env.local` / Vercel / GitHub secrets** — `HUBSPOT_PAT` (sync);
  `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (auth) + `SUPABASE_SERVICE_ROLE_KEY`
  (spine + call-quality + agent, server-only); `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`, default
  `gpt-4o-mini`) for the agent; `CRON_SECRET` (optional, `/api/sync/delta`); `BLOB_READ_WRITE_TOKEN`
  (optional Blob fallback). **In prod the middleware fails CLOSED (503) if the `NEXT_PUBLIC_SUPABASE_*`
  vars are missing.** GitHub crons need repo secrets `HUBSPOT_PAT`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, and `OPENAI_API_KEY` (for the agent).
- **Auth gate** — `middleware.ts` is the single source of truth (session + `@spyne.ai` via
  `lib/auth/domain.ts`); `PUBLIC_PATHS` exempts `/login`, `/auth`, `/api/sync/delta` (constant-time
  `CRON_SECRET` check). `/api/*` → JSON 401; pages → `/login`. Missing env = pass-through in dev, 503
  in prod.
- **RLS floor** — `sdr_*` tables allow `SELECT` only for `authenticated` `@spyne.ai` + `provider=google`
  JWTs; no write policies (service-role bypasses RLS). The shared project must not enable
  email/password signup (see the schema comment).
- **Call-quality merge (read-only)** — `lib/callquality/*` reads the call-scoring tables
  (`rep_coaching_snapshots`, `calls`, `call_quality_insights`) via the service-role key; never
  modified. The drawer's BANTIC card was removed, but this data still feeds the **agent**.

## UI notes

- **Design system.** Token-driven: CSS variables in `app/globals.css` → Tailwind theme
  (`bg-surface`, `text-ink[-muted/-subtle]`, `border-line`, `text-primary`, `bg-hot/warm/cold` +
  `-weak`). Fonts via `next/font` (Hanken Grotesk UI + JetBrains Mono for metric values); icons via
  `lucide-react`. Primitives in `components/ui/index.tsx` (`Surface`, `StatTile`, `Chip`, `Bar`,
  `Avatar`, `GradeBadge`, `SortHeader`, `TempBadge`, `cn`); shared chip/temp lookups in
  `components/ui-tokens.ts`. **Tailwind JIT gotcha:** dynamically-built classes like `text-${temp}`
  are purged — keep a literal map (e.g. `TEMP_TEXT` in `Dashboard.tsx`).
- **Main component** `components/Dashboard.tsx` (client); clicking a rep row opens `RepDrawer`
  (children-based to avoid an import cycle) containing `Scorecard`. The **Book Explorer**
  (`GdExplorer`) and "Accounts tapped this period" both render the shared nested table
  `components/AccountsTable.tsx` (`UnitsTable` → `RooftopsTable` → `ContactsTable`). Temperature
  tiles + meeting/hot chips are clickable → filter the accounts table. The **monthly** card has a
  month picker (This/Last/2-months-ago); a true arbitrary-day date range is NOT implemented (would
  need a Postgres range function).
- **Charts are hand-built** (no charting library): CSS donut/bars + an interactive SVG-ish daily
  chart (hover tooltip, gridlines, axis labels). State is local (`useState`/`useMemo`); no store.
- **HubSpot deep-links** — `config/hubspot.ts`: `companyUrl` (0-2), `contactUrl` (0-1), `dealUrl`
  (0-3), `meetingUrl` (0-47), `callUrl` (0-48). Portal `242626590`, app-na2.

## The hot-account AI agent (`lib/agent/*`)

- **Read-only on HubSpot.** Reasons over the snapshot's hot accounts (`this_week` breakdown) + the
  call-scoring distilled text (coaching summary, quoted moments, next-action) + raw call/email
  content from `sdr_activity_content` (present only after `content:backfill`; degrades gracefully).
- **Pieces:** `detect.ts` (pure `detectWatchWork` — newly-hot / stale / intent-shift → review;
  quiet cooled watches → drop-off; unit-tested), `prompt.ts` (`SYSTEM_PROMPT` — grounded, read-only,
  strict JSON verdict), `context.ts`, `openai.ts` (`reason()`, JSON-validated), `store.ts`
  (`sdr_agent_watches`/`sdr_agent_notes`/`sdr_activity_content`), `runner.ts` (`runAgent`, caps ~25
  accounts/run). Model `OPENAI_MODEL` (default `gpt-4o-mini`).
- **Surface:** `/attention` (`AttentionBoard`, priority/rep filters, HubSpot backlinks) +
  `/api/agent/watches`.
- **Activation (one-time):** apply `supabase/sdr_schema.sql` (adds `sdr_activity_content`,
  `sdr_agent_watches`, `sdr_agent_notes`, and the `sdr_save_snapshot` RPC) + set the `OPENAI_API_KEY`
  secret. The `spine-agent` cron then runs every 2 h.

## Derived-metric definitions (`lib/sync/aggregate.ts` unless noted)

- **Temperature** — see the conventions bullet + `lib/sync/temperature.ts`.
- **Quality score** (`computeQuality`): weighted 0–100 → A–F, from five sub-scores (conversations,
  depth, persistence, channel balance, deliverability).
- **Coverage** (`computeBookCoverage` → `RepData.book`): cumulative, monotonic, owner-attributed;
  owned rooftops rolled up to GD/Single units (group = `is_this_is_a_part_of_group_dealership_` AND a
  `gd_id`, else single). Segmented by GD-level lifecycle (`lifecycle_stage_gd_level` →
  `normalizeGdStage`), market segment, dealership type. Measured over the `COVERAGE_ANCHOR` pull.
- **Monthly new-unique** (`RepData.monthly`): per-account/per-contact first-tap tracked over all
  history; "new in month M" = first ever worked in M. Owned-book scoped.
- **Insights** — `buildInsights` (per-period activity callouts) + `bookInsights` (coverage callouts).

## Refresh workflow

- **First-time setup:** apply `supabase/sdr_schema.sql`, run `npm run verify:schema`, then
  `npm run sync:backfill` once (~1 h).
- **Steady state:** `spine-delta.yml` every 15 min, `spine-reconcile.yml` nightly (06:30 UTC),
  `spine-agent.yml` every 2 h. The delta writes `sdr_snapshots`; the deployed app reads it live (no
  redeploy needed). Adding reps to `config/reps.ts` needs a reconcile/backfill to pull their history.
- **Recovery:** `npm run sync:reaggregate` rebuilds the snapshot from the spine (no HubSpot) — use
  after an aggregate change or a `saveSnapshot` timeout.
- **Manual trigger:** `workflow_dispatch` on any workflow, or `GET /api/sync/delta` with
  `Authorization: Bearer $CRON_SECRET`.
- **Legacy:** `data/snapshot.json` is an empty placeholder (build-time static import + last-ditch
  fallback); `npm run sync` + the old `sync.yml` are retired.
