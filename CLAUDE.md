# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**TrackerAI** (renamed from "SDR Outreach Coverage") — an SDR & AE **account-tracking sales cockpit**
for sales leadership. It began as a **coverage** tool (*are all accounts being tapped?*) and now layers
the full **lead→demo→closure funnel** + **intelligence** on top:

- **Coverage/quality** — per rep and per US/Eastern window: unique contacts/companies touched,
  depth, call-outcome + email breakdown, owned-book coverage, a composite quality score.
- **Deals + demo-status funnel (V2)** — HubSpot **deals** are a first-class object (Auto Pipeline).
  Each owned company is segmented **Demo Pending / Scheduled / Done** (`lib/sync/segmentation.ts`), and
  `RepData.funnel` counts them per rep. Canonical, collision-safe stage model in `config/deal-stages.ts`.
- **Two-indicator health (V2)** — accounts *with* a live deal get **Deal Health** green/yellow/red
  (`lib/sync/deal-health.ts`, stage + recency); accounts *without* one keep **Temperature** hot/warm/cold
  (`lib/sync/temperature.ts`). Never merged — Temperature governs lead→demo, Deal Health governs demo→closure.
- **Account temperature** — hot/warm/cold from call *outcomes* + engagement, recency-aware "disqualified" rule.
- **Coverage (owner-recency)** — `CoverageStatus` = `tapped` (the OWNER worked it ≤60d) /
  `worked_by_other` (only a different tracked rep did) / `untapped`; GD units flag `mixed_owner`.
- **Monthly new-vs-existing** — per rep, rooftops/contacts worked this month + how many are brand new.
- **Hot-account AI agent** — an OpenAI copilot that watches hot accounts and produces a grounded
  "why hot + next step" task list at `/attention` (`lib/agent/*`). HubSpot read-only.

Surfaces: **Overview** (`/`, the rep table + Demo funnel + SDR/AE toggle), **Accounts** (`/accounts`,
owned book by demo-status with GD→rooftop→contact drill, Deal Health/Temperature + last-activity),
**Attention** (`/attention`), **Admin** (`/admin`). Shared top-nav in `components/AppNav.tsx`.

Read `README.md` for product definitions and setup. This file covers architecture and the
non-obvious conventions that span multiple files. Other docs: `docs/AI-CRM-BLUEPRINT.md` is the V3
master spec (SHIPPED through P3; P4 write-back/Slack digests pending); `AGENTS.md` is a **symlink to
this file** (never edit it separately); `MISTRAL.md` is a legacy V2-era deep-dive on the Enhanced
Attention Board whose inline code samples include unshipped aspirational features — don't treat it
as current state; `docs/superpowers/*` are historical phase-1/2/3 plans and specs.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the dashboard locally (http://localhost:3000) |
| `npm run build` | Production build — also runs the TypeScript typecheck (there is no separate `tsc` script) |
| `npm run lint` | ESLint (`next/core-web-vitals`) |
| `npm test` | Run all Vitest unit tests (`vitest run`) |
| `npm run verify:schema` | Probe that `supabase/sdr_schema.sql` is applied (tables reachable, seeds present, anon blocked) |
| `npm run sync:backfill` | Full pull → Postgres spine (~35–40 min; pulls the whole tracked roster from DB). Run for the first delta / after a big roster change |
| `npm run sync:delta` | Incremental sync: pull `hs_lastmodifieddate > watermark`, upsert, re-aggregate (O(changes)) |
| `npm run sync:reconcile` | Nightly drift heal: full owned-book re-pull + 7-day activity re-pull |
| `npm run sync:reaggregate` | Rebuild the snapshot from the spine **without a HubSpot pull** (recover from a saveSnapshot failure; logs raw + gzipped size) |
| `npm run team:seed` | Seed `sdr_roster`/`sdr_pods`/`sdr_managers` from `config/*.ts` (idempotent, edit-safe; validates owner ids vs `sdr_owners`, skips fabricated ones) |
| `npm run pull:owner` | Targeted full-history pull for ONE owner (`OWNER_ID=… npm run pull:owner`). Used by the admin add-user auto-pull (`spine-pull-owner.yml`) |
| `npm run content:backfill` | **Opt-in** pull of call notes/transcripts/email subjects → `sdr_activity_content` (kept OFF the delta path) |
| `npm run agent:run` | One hot-account agent pass (OpenAI reasoning → `sdr_agent_watches`); needs `OPENAI_API_KEY` |
| `npm run agent:briefs` | Refresh grounded Account Briefs for watched accounts (timeline + content + deals → `sdr_agent_briefs`); needs `OPENAI_API_KEY`; runs as the 2nd step of `spine-agent.yml` |
| `npm run embed:content` | Index new `sdr_activity_content` rows into `sdr_embeddings` (pgvector; idempotent, new rows only); needs `OPENAI_API_KEY`; runs nightly after `content:backfill` in `spine-reconcile.yml` |

All non-`dev`/`build`/`lint`/`test` scripts run via `tsx --conditions=react-server` — required so
the `server-only` guard in `lib/supabase/admin.ts` resolves to a no-op under plain Node. Scripts
load env from `.env` then `.env.local` (so put local secrets, incl. `OPENAI_API_KEY`, in `.env.local`).

**No CI gate.** All six `.github/workflows/*` are cron/manual data-sync jobs — none run on `push`
or `pull_request`, so `lint`/`test`/`build` are **not** enforced in CI. Run `npm run build` (typecheck),
`npm test`, and `npm run lint` locally before pushing.

Run a **single test**: `npx vitest run tests/temperature.test.ts` (add `-t "name"` to filter by
test name; drop `run` for watch mode). Tests (`tests/`) cover only pure logic: US/Eastern bucketing
(`buckets.test.ts`, incl. DST cases), aggregation incl. GD book units + owner≠doer + monthly + deal
integration (`aggregate.test.ts`, plus GD-grouping edge cases in `aggregate-gd-grouping.test.ts`),
activity/deal→company association (`associate.test.ts`), the temperature classifier
(`temperature.test.ts`), the canonical deal-stage engine incl. the pipeline-collision guard + the
V3 active/parked/demo-completed predicates (`deal-stages.test.ts`), stage-event extraction + row
mappers (`stage-events.test.ts`), demo-status segmentation (`segmentation.test.ts`), Deal Health
(`deal-health.test.ts`), call-quality mappers (`callquality.test.ts`), spine row mappers incl. deal
mappers (`spine-rows.test.ts`), the RBAC scope decision (`access.test.ts`), the agent detector
(`agent-detect.test.ts`), the agent prompt builder (`agent-prompt.test.ts`), the attention ranking
(`agent-ranking.test.ts`), the auth-domain rule (`auth-domain.test.ts`), the pod/team filter
options (`team-filters.test.ts`), the account-timeline builder (`account-timeline.test.ts`),
Forecast v1 (`forecast.test.ts`), the integrity checks (`integrity.test.ts`), and the embedding
chunk composer (`embed-chunks.test.ts`) — 21 files / 208 tests in all. Never
import a `server-only`-guarded module (`lib/supabase/admin.ts`,
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
       ├─ lib/sync/pull.ts        pullChangedActivities / pullChangedCompanies / pullChangedDeals (hs_lastmodifieddate > watermark)
       │    └─ lib/hubspot/client.ts  hubspotFetch — the ONE HubSpot HTTP layer (also under associate.ts +
       │                              content-backfill): reads HUBSPOT_PAT; retries ×5 on 429 (Retry-After,
       │                              ≤60s), 5xx, and THROWN network errors (a dropped socket would otherwise
       │                              abort a long batch pull); 300ms request spacing. Distinct from
       │                              config/hubspot.ts, which is deep-link URL builders only.
       ├─ lib/sync/associate.ts   resolve activity/deal → contact → company (v4 batch reads); resolveDealAssociations
       ├─ lib/sync/stage-events.ts pure hs_v2_date_entered/exited_<stageId> → DealStageEvent extraction (V3)
       ├─ lib/spine/store.ts      batched upserts into sdr_activities/companies/contacts/deals/
       │                           deal_stage_events/contact_companies/owners; saveSnapshot()
       └─ lib/sync/aggregate.ts   rebuild the Snapshot: reach, temperature (temperature.ts), Deal Health
                                   (deal-health.ts), demo-status (segmentation.ts), owner-recency coverage,
                                   per-rep funnel, event-truth demos + active/inactive pipeline (V3),
                                   monthly new-unique, quality, insights
             ↓  saveSnapshot()  (sdr_save_snapshot RPC, else retrying upsert)
  sdr_snapshots (one jsonb row, id=1)   ← the delta writes this; getSnapshot reads it first
             ↓
  lib/snapshot.ts   getSnapshot: loadFromSpine → loadFromBlob → loadFromFile → empty  (+ stripBookUnits)
             ↓
  middleware.ts  ── auth gate (session + @spyne.ai domain) ── app/login, app/auth/callback
             ↓
  components/AppNav.tsx  shared top-nav: Overview · Accounts · Attention · Admin
  app/page.tsx   resolveViewer(email) + snapshot (units stripped)  → components/Dashboard.tsx (rep table, Demo funnel, SDR/AE toggle)
  app/accounts   resolveViewer + snapshot → components/Accounts.tsx  (owned book by demo-status; lazy per-rep units via /book)
  app/admin      control center: add/update users (email→owner), roster + soft-delete, manage pods/managers, roles, sync health   (admin only)
  app/attention  hot-account task list (AttentionBoard / AttentionBoardEnhanced) ← sdr_agent_watches
  app/api/rep/[ownerId]/book|calls   lazy per-rep drill-downs   ·   app/api/agent/watches
  app/api/metrics/range   arbitrary from–to ET window → aggregateRange over the spine (V3; same
                          pure engine as the fixed periods; 190-day cap; session-gated like all /api)
  app/api/account/[companyId]/timeline   per-account unified history (V3 P2d): calls/emails (jsonb
                          contains on company_ids — needs the JSON-string form + the GIN index) +
                          deal journeys from the stage-event ledger + agent watch; pure assembly in
                          lib/sync/account-timeline.ts → components/AccountTimeline.tsx (History
                          button on each Accounts rooftop row + Deal Funnel row)
  app/api/deals   the Deal Funnel workbench (V3): stage-wise counts + $ per canonical stage +
                          merged Lost block, ledger flow conversion (scheduled→completed→contract→won),
                          Forecast v1 (lib/sync/forecast.ts — RESOLVED-cohort conversion per stage,
                          median stage velocity, conversion-weighted expected pipeline value; thin
                          cohorts <20 show null, amounts never imputed), and up to 100 deals/stage in
                          ONE response (client stage-clicks don't refetch); lens=sdr|ae|all picks the
                          crediting owner field; contract in lib/sync/deal-funnel.ts →
                          components/DealFunnel.tsx (incl. ForecastCard)
  app/api/integrity   read-only data-integrity queue (V3 P3b): pure checks in
                          lib/integrity/checks.ts — active orphan deals, slipped demos, stale actives
                          (30d/60d), deal-vs-account owner mismatches, ledger stage regressions — each
                          with a deterministic suggested action; rendered by
                          components/admin/IntegrityQueue.tsx on /admin
  app/api/sync/delta   CRON_SECRET-gated alt trigger for runDelta

scripts/agent-run.ts  (.github/workflows/spine-agent.yml, every 2 h)
  └─ lib/agent/runner.ts  runAgent: hot accounts (snapshot) → detect.ts → OpenAI (openai.ts) → sdr_agent_watches/notes
```

The heavy pull runs **outside Vercel** (a sync exceeds serverless limits). Cadence: the delta is driven
by a **self-perpetuating heartbeat** (`spine-delta-heartbeat.yml`, loops `sync:delta` every ~15 min and
self-redispatches — defeats GitHub's throttled `schedule:`; see the sync convention below), with
`spine-delta.yml` (`*/15`) as a fallback; reconcile nightly (`spine-reconcile.yml`); agent every 2 h
(`spine-agent.yml`); `spine-backfill.yml` + `spine-pull-owner.yml` are manual-dispatch-only wrappers
for `sync:backfill` / `pull:owner` (that's all six workflows). Shared contracts: `lib/sync/types.ts`
(sync↔UI, incl. `Deal`, `AccountDeal`, `RepFunnel`, `CoverageStatus`, `DemoStatus`, `DealHealth`),
`lib/spine/types.ts` (`sdr_*` rows +
`Viewer` incl. `kind`), `config/deal-stages.ts` (canonical stage model), `lib/callquality/types.ts`
(read-only call-scoring), `lib/agent/types.ts` (agent I/O).

### Data model
`Snapshot` → `owner_names`, **`owner_kinds`** (id→`sdr`/`ae`, drives the SDR/AE toggle), `reps[ownerId]`
→ `{ periods[periodKey]: PeriodMetrics, daily[], book, monthly[], funnel }`.
Six US/Eastern periods (`today`…`this_month`). `PeriodMetrics` bundles volume, reach-by-channel,
DM reach, `temp` (AccountTemp counts), and quality. The three **narrow periods** (`today`,
`yesterday`, `this_week`) also carry `company_breakdown` (per-account rows with enriched contact
lists + an `AccountDeal` block) — others omit it to keep the snapshot small. `RepData.book`
(`BookCoverage`) is **period-independent**; `book.units` is the GD → rooftop → contacts drill-down
(heavy — stripped from the page, lazy-loaded via `/book`; the Accounts page reuses it). Each
`RooftopDetail` carries `coverage` (`CoverageStatus`), an optional `deal` (`AccountDeal`: demo-status,
Deal Health, stage, at-risk/revive flags) and `last_activity` (date/type/outcome/owner/contact).
**`RepData.funnel`** (`RepFunnel`) counts owned rooftops by demo-status (Pending/Scheduled/Done +
`scheduled_at_risk`). `RepData.monthly` is the last 3 ET months of new-vs-existing tapped rooftops/contacts.
**V3:** `PeriodMetrics.demos` (`{scheduled, completed}` — event-truth per period) and `RepData.pipeline`
(`RepPipeline`: active pre/post-demo, parked, won, lost, by_stage) — both optional; guard on pre-V3 snapshots.

## Conventions & gotchas (the load-bearing rules)

- **Snapshot is ONE jsonb row, stored gzip-compressed.** At 42 reps × thousands of owned rooftops
  the raw snapshot is ~9.5 MB, and the single-row write tripped Postgres `statement_timeout` (the
  RPC's `SET LOCAL` was not effective — the pooler/role default won). `saveSnapshot` (`lib/spine/store.ts`)
  now **gzip-compresses** it (`packSnapshot` → base64 in the jsonb column, shape `{__gz,v}`) — ~9.5 MB
  → ~1.7 MB, so the write is small and fast and scales as the roster grows. It still prefers the
  `sdr_save_snapshot(jsonb)` RPC but **falls back to a retrying upsert on ANY rpc error** (was:
  only missing-function). `loadSnapshotRow` transparently decompresses via `unpackSnapshot` and
  still reads legacy raw rows (backward compatible). `ROOFTOP_CONTACT_CAP` (12) still bounds contacts
  per rooftop. Recover/rebuild with `npm run sync:reaggregate` (spine-only, no HubSpot pull; logs
  both raw + compressed size). A failed write leaves the last good row intact.
- **Coverage is attributed to the account's OWNER, not the activity doer** (`aggregate.ts`,
  `companyOwner` map). Engagement on an owned rooftop rolls up to the owner's book whenever ANY tracked
  rep works it. Per-rep **period** metrics (touches, reach, daily) stay per activity-doer.
- **Coverage status is owner-recency, 3-state** (`CoverageStatus`, `aggregate.ts` `computeBookCoverage`;
  `RoofAcc.ownerLastMs`/`otherLastMs`): `tapped` = the **OWNER** worked the rooftop within **60d**
  (`OWNER_RECENCY_MS`); `worked_by_other` = only a *different* tracked rep did (owner didn't) within 60d;
  else `untapped`. A GD unit is `tapped` if ANY rooftop is owner-recent, and flags `mixed_owner` when its
  rooftops span >1 tracked owner (only partially this rep's book — `gdOwners`). This replaced the old
  monotonic "tapped once ever by anyone" boolean. **Temperature still keys off the all-history "touched
  ever by anyone" set (`everTapped`)** for its untouched detection — the two notions are intentionally
  distinct. Unit vs single classification is by **group association**, not the raw `is_group` flag
  (`unitKeyFor`).
- **Temperature is outcome-driven (`lib/sync/temperature.ts`, `classifyTemperature`).** Pure
  classifier over per-account signal counts (built in `aggregate.ts` from the raw disposition GUID
  on every `sdr_activities` row via `config/dispositions.ts` categories). Rules, first match wins:
  HOT (meeting scheduled/rescheduled, callback-high, callback-low ×2, email reply); WARM (referral,
  callback-low ×1, any connect, email open); COLD (no-connect / untouched / **disqualified**). A
  connected-but-negative outcome (Not Interested, Not a Right POC, bad/wrong number, left org) pulls
  the account to cold — **unless a more recent positive signal revives it** (recency via
  `lastPositiveMs`/`lastNegativeMs`). Same engine runs per account, per owned rooftop, and per contact.
  **Two-indicator rule:** Temperature only governs accounts with **no live deal**; accounts with a live
  deal show **Deal Health** instead (see the deals bullet). In the snapshot, a rooftop's `deal.health` is
  null exactly when Temperature governs — the UI picks whichever is set.
- **Deals are Auto-Pipeline-only + collision-safe (`config/deal-stages.ts`).** HubSpot's `dealstage` is
  one flattened enum shared across 8 pipelines, and the SAME label maps to DIFFERENT stage ids per
  pipeline — so **all logic keys on the canonical `stageKey(pipeline, dealstage)`**, never a bare id.
  Only the Auto Pipeline (`1001348836`) is mapped; everything else → `other`. `sdr_deals` is pulled
  scoped to tracked owners via **two passes** (`hubspot_owner_id` = AE, `sdr_owner` = SDR) unioned by id
  (`pullChangedDeals`), then deal→company/contact resolved (`resolveDealAssociations`). Derived per owned
  company: **demo-status** (`segmentation.ts` `segmentAccount` → Demo Pending / Scheduled / Done, +
  at-risk/revive flags — the "furthest live deal" governs) and **Deal Health** (`deal-health.ts`
  `classifyDealHealth` → green/yellow/red: terminal stages decide on stage alone, else a 14d→yellow /
  30d→red recency ladder; a Demo-Scheduled deal whose demo date has passed → yellow). Both attach to
  `RooftopDetail.deal` and feed `RepData.funnel`. All three (stage map, segmentation, health) are pure +
  unit-tested (`deal-stages`/`segmentation`/`deal-health` tests).
- **V3 funnel truth is EVENT-based, never current-stage-based.** `sdr_deal_stage_events` records WHEN
  each deal entered/exited each canonical stage, from HubSpot's built-in
  `hs_v2_date_entered/exited_<stageId>` calculated properties (pure extraction in
  `lib/sync/stage-events.ts`; requested in the same deals pull — no property-history API). Period
  metrics: **Demos Scheduled** = entered `discovery_done` in the period (deals are created at that
  stage in practice — verified live: entered == createdate); **Demos Completed** = FIRST entry into
  `demo_done`/`demo_accepted`/`in_discussion` (locked: all three count). `demoScheduledMs`/
  `demoCompletedMs` (`aggregate.ts`) are ledger-first with stage-date-column fallback, bucketed via
  the same `periodsForActivity` as activities → `PeriodMetrics.demos`. **Active/inactive segregation**
  (`computeRepPipeline` → `RepData.pipeline`): active = in-funnel, not terminal, not parked
  (`isActive`; `future_prospect` is **parked** by decision; `transferred_cs` counts as won), split
  pre/post-demo via `isPostDemo`. SDRs are credited via `sdr_owner`, AEs via `hubspot_owner_id` —
  two lenses, never summed. `sdr_contact_companies` is the explicit contact↔rooftop M:N junction
  (fed from association reads already on the delta path — no extra HubSpot calls). Both new tables
  degrade gracefully pre-migration (own try/catch; the loader falls back), and the nightly
  reconcile's full deal re-pull backfills the ledger once the schema is applied.
  **Orphan-deal heal:** ~44% of Auto-Pipeline deals have NO company association in HubSpot and
  used to vanish from demo-status/funnel/health — `resolveDealAssociations` now falls back to the
  first associated contact's primary company (`fallbackCompanyFor`, pure + tested).
- **Reconcile MUST retry lock contention.** The advisory lock is usually held by a ~15-min delta
  heartbeat run, so a single `runReconcile` attempt frequently no-ops while the workflow still
  reports success (observed repeatedly: 30-second "successful" reconciles that did nothing).
  `runReconcile` returns `{ ran }` and `scripts/spine-reconcile.ts` retries (2-min × 15) until it
  actually runs. Treat any suspiciously fast reconcile as a silent no-op.
- **"Connected" is a business rule, not `hs_call_status`.** Only the 11 GUIDs in
  `config/dispositions.ts` `CONNECTED_DISPOSITIONS` count as reaching a human. Ported verbatim from
  `call-scoring-agent/config/dispositions.py`; keep in sync. `connect_rate` excludes null-disposition
  calls from the denominator.
- **The roster + org structure are DB-backed and admin-editable** (`sdr_roster`, `sdr_pods`,
  `sdr_managers`), NOT hard-coded. `lib/team/load.ts` `loadTeamStructure()` reads them into a
  `TeamStructure` (`lib/team/types.ts`); `getTrackedOwnerIds()` is the successor to `REP_OWNER_IDS`
  and is the `IN` filter for HubSpot searches (threaded through `lib/sync/pull.ts`, `aggregate.ts`,
  `spine/store.ts`+`runner.ts`, `callquality/fetch.ts`). **`config/reps.ts` + `config/team-structure.ts`
  are now the seed + fallback only** — `lib/team/config-source.ts` `configTeamStructure()` builds a
  `TeamStructure` from them, used when `sdr_roster` is empty/unreachable so nothing breaks
  mid-migration. Seed the DB from config with `npm run team:seed` (validates owner ids against
  `sdr_owners`, skips fabricated ones). Adding a rep still needs history pulled: the admin add-user
  action (`components/admin/AddUserForm.tsx`) auto-fires a **targeted single-owner backfill**
  (`runOwnerBackfill` → `spine-pull-owner.yml`, needs `GH_DISPATCH_TOKEN`+`GH_REPO`); else
  `reconcile`/`backfill` catches them. **Never hand-enter
  owner ids** — resolve by email against `sdr_owners` (owner ids must be real HubSpot owners).
- **RBAC is a 3-level focus model over the DB `TeamStructure`** (NOT HubSpot teams): SDR → AE pod →
  Manager, keyed by owner id; some SDRs are player-coach managers/TLs (TLs roll up to a parent).
  Pure helpers in `lib/team/helpers.ts` (podByEmail/allOwnersInPod/managerKeyByOwnerId/
  sdrOwnersUnderManager) take a `TeamStructure`. `decideScope` (`lib/access/scope.ts`, pure,
  unit-tested) takes the structure as a param: admin/leadership → all; AE pod lead by login email →
  pod's SDRs+AEs; manager/TL by owner id → subtree + self; individual → own book; else org-wide
  viewer. `resolveViewer` (`lib/access/resolve.ts`) loads the structure from DB + always resolves the
  login's owner id. **Focus model, not confidentiality** — everyone keeps the "All reps" toggle;
  `resolveViewer` never throws (degrades to org-wide). Admin add-user: **Role** (User/Manager/Admin →
  `sdr_roles`) and **Type** (SDR/AE/access-only → `sdr_roster`) are INDEPENDENT — access-only writes
  no roster row (fixes admins being mislabeled reps).
- **Snapshot loader must use a static `import()`, not `fs`** (`lib/snapshot.ts`) — a runtime path is
  missed by Vercel output-file-tracing.
- **The 10k Search ceiling** — legacy full pull slices into 7-day windows; delta pulls cut each
  modified-window at 9,800 and resume from `lastmodified − 1` (callers dedupe), at most
  `MAX_RESUME_WINDOWS` (3) per run, deferring the rest (watermark still advances — no livelock).
- **Sync degrades gracefully on 403** — `preflightCaps()` probes calls/emails independently, returns
  false only on a 403 scope error; the dropped type is recorded in the snapshot's `sources`. Emails
  need the `connected-email-data-access` scope.
- **Change-feed sync is watermark-driven + idempotent** — per-type watermarks in `sdr_sync_state`
  (`calls`/`emails`/`companies`/`deals`); each delta re-reads from `watermark − OVERLAP_MS` (5 min) and
  advances only after upserts + re-aggregate succeed (all upserts PK-idempotent). One run at a time via
  an advisory lock (the `lock` row), fenced by a lease token. Owner-moves-away are corrected by the
  nightly reconcile; HubSpot deletions are not propagated (accepted gap).
- **The delta cadence comes from a self-perpetuating heartbeat, NOT GitHub `schedule:`.** GitHub
  throttles scheduled crons hard on public repos (measured: the `*/15` fired ~hourly with multi-hour
  gaps). `spine-delta-heartbeat.yml` runs ONE long-lived job that loops `sync:delta` every ~15 min for
  ~5h20m, then **re-dispatches itself** before the 6h cap (needs the `GH_DISPATCH_TOKEN` **Actions**
  secret — a PAT with `actions:write`; `GITHUB_TOKEN` cannot trigger `workflow_dispatch`). `spine-delta.yml`
  (`*/15`) stays as a fallback, and the heartbeat has its own cold-start `schedule:` (`27 */3 * * *`) so a
  dead chain revives within ~3h; the advisory lock makes overlap safe. Public repo = free unlimited Actions
  minutes, so the sleeping loop costs nothing. Gotcha: GitHub resolves `secrets.*` at **job start**, so a
  run already in flight when a secret is added sees it empty — test with a run dispatched *after*.
- **Deals degrade gracefully before the V2 migration.** `persistDeals` swallows a missing-`sdr_deals`
  error, `runDelta` reads the `deals` watermark defensively, and `loadStoreForAggregate` aggregates
  without deals if the table is absent — so the sync keeps working until `supabase/sdr_schema.sql`
  (the `sdr_deals` table + company `lifecycle_stage`/`last_activity_ms`/`rooftop_last_activity_ms`
  columns + the `deals` sync_state seed) is applied. The client UI likewise tolerates a pre-V2 snapshot
  with no `funnel`/`owner_kinds`.
- **Secrets live only in `.env.local` / Vercel / GitHub secrets** — `HUBSPOT_PAT` (sync);
  `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (auth) + `SUPABASE_SERVICE_ROLE_KEY`
  (spine + call-quality + agent, server-only); `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`, default
  `gpt-4o-mini`) for the agent; `CRON_SECRET` (optional, `/api/sync/delta`); `BLOB_READ_WRITE_TOKEN`
  (optional Blob fallback). **In prod the middleware fails CLOSED (503) if the `NEXT_PUBLIC_SUPABASE_*`
  vars are missing.** GitHub crons need repo (Actions) secrets `HUBSPOT_PAT`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` (agent), and **`GH_DISPATCH_TOKEN`** (a fine-grained
  PAT minted by the `salesops-lab` GitHub account, `actions:write` — powers the heartbeat
  self-redispatch AND the admin add-user owner-pull dispatch; also lives in Vercel env for the
  server-action path; PATs are repo-owner-scoped, so a repo transfer kills them — re-mint from the
  new owner).
- **Ownership footprint (migrated to salesops@spyne.ai, 2026-07-14).** Repo:
  `salesops-lab/sdr-outreach-dashboard`; Vercel project `sdr-outreach-dashboard` under the salesops
  account (Hobby — no team members possible; the old kaus-spyne project was recreated, not
  transferred, since Hobby→Hobby transfer is Pro-gated). Production domains (all one project):
  `spyne-sales-activity-tracker.vercel.app` (the team bookmark), `sdr-outreach-dashboard.vercel.app`,
  `sales-outreach-tracker.vercel.app`. App admin + infra identity: `salesops@spyne.ai` (`sdr_roles`
  admin; Owner on the GCP project holding the Google OAuth client — the client itself never changed,
  so login needed no reconfig). Vercel gotchas that bit during migration: `vercel env pull` returns
  EMPTY strings for sensitive-type vars (length-check before reusing), and API redeploys reuse the
  build cache so changed `NEXT_PUBLIC_*` values don't inline — deploy fresh from `gitSource` instead.
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
  `Avatar`, `GradeBadge`, `SortHeader`, `TempBadge`, **`Segmented`** (lifted here so Dashboard + Accounts
  share it), **`DealHealthBadge`** (green/yellow/red pill), `cn`); shared chip/temp lookups in
  `components/ui-tokens.ts`. **Tailwind JIT gotcha:** dynamically-built classes like `text-${temp}`
  are purged — keep a literal map (e.g. `TEMP_TEXT` in `Dashboard.tsx`, `FUNNEL_TINT` in the funnel strip).
- **Shared nav** `components/AppNav.tsx` (Overview · Accounts · Attention · Admin; Admin only when
  `viewer.isAdmin`) sits atop each authenticated page. `viewer.kind` (SDR/AE, resolved in
  `lib/access/resolve.ts`, kept off the pure `decideScope`) defaults the Accounts lens.
- **Overview** `components/Dashboard.tsx` (client): rep table + a **Demo funnel strip** (`FunnelStrip`
  from `RepData.funnel`, links into `/accounts`) + an **SDR/AE toggle** (managers/admins only —
  `viewer.isAdmin || role manager|leadership` — filters reps via `snapshot.owner_kinds`). Clicking a rep
  row opens `RepDrawer` (children-based to avoid an import cycle) containing `Scorecard` (an inline
  component in `Dashboard.tsx`, not a separate file). **Guard** reads
  of `RepData.funnel` / `owner_kinds` — absent on a pre-V2 snapshot; `m.demos` / `data.pipeline` —
  absent on a pre-V3 one. **V3 additions:** an **AE Pod / SDR Team dropdown** (options built
  server-side by `teamFilterOptions` in `lib/team/helpers.ts` and passed as the `teamFilters` prop —
  Overview + Accounts both), a **from–to date-range picker** (swaps the table/tiles to
  `/api/metrics/range` results; period chips deselect), a sortable **Demos** column + per-rep
  **Funnel** cells deep-linking to `/accounts?lens&bucket&rep`, and a **PipelineCard** in the drawer.
- **Deals & Accounts** `components/Accounts.tsx` (client, `/accounts`) — the deal-funnel page, two
  views (**Funnel | Book** toggle; URL `bucket` deep-links land on Book, `view=` overrides):
  **Funnel** (`components/DealFunnel.tsx` ← `/api/deals`) renders three lanes (Lead→Demo SDR motion,
  Demo→Closure AE motion, Closed) + Parked/Lost blocks, the ledger flow-conversion line, and a
  sortable deal workbench (longest-in-stage first; 14d/30d heat on days-in-stage; HubSpot deal +
  company backlinks; History panel per row). Works across ANY scope — the rep select has an
  **"All reps"** option (`""`), so team filter + rep select no longer conflict; Funnel scope =
  rep > team > viewer scope. **Book** is per-rep (prompts if All-reps): GD cards **collapsed by
  default** with a summary row (sched/done/hot + rooftop count; filters auto-expand), rooftop rows
  in a 5-column grid (Account · Demo status · Health/Temp · Deal stage · Last activity), demo-status
  tabs + column filters (Health incl. "no deal — Temp governs", Temp, GD Stage, Segment), contacts
  expandable. The drawer's Book Explorer (`GdExplorer`) keeps matching Stage/Segment/Temp selects. **AE view currently reuses the owned-book buckets** — a true deal-owner ("In Discussion")
  cross-cut needs a deal-owner rollup in the aggregator (follow-up).
- **Reused table** `components/AccountsTable.tsx` (`UnitsTable` → `RooftopsTable` → `ContactsTable`) still
  backs the **Book Explorer** (`GdExplorer`) and "Accounts tapped this period". Temperature tiles +
  meeting/hot chips are clickable → filter the accounts table. The **monthly** card has a month picker
  (This/Last/2-months-ago); a true arbitrary-day date range is NOT implemented (needs a Postgres range fn).
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
  strict JSON verdict), `context.ts`, `openai.ts` (`reason()` + **`completeJSON` — the provider seam
  every reasoner shares**), `store.ts` (`sdr_agent_watches`/`sdr_agent_notes`/`sdr_activity_content`),
  `runner.ts` (`runAgent`, caps ~25 accounts/run), **`briefs.ts` (V3 §7.2: grounded Account Briefs —
  summary/stakeholders/signals/objections each with dated evidence + next step → `sdr_agent_briefs`,
  stale-refresh ~20h, `runBriefs` caps 15/run)**, **`embed-chunks.ts` (pure, tested: what earns a
  vector) + `embeddings.ts` (index/search over `sdr_embeddings` pgvector via the `sdr_search_content`
  RPC; `hasIndexedContent` gates the loop) + `toolloop.ts` (V3 §7.3: generic read-tools loop — the
  model MUST finish via the submit tool, whose args ARE the structured output)**. Brief generation is
  agentic when the account is indexed (search_account_history over the WHOLE history, 5-search
  budget) and single-shot otherwise. Model `OPENAI_MODEL` (default `gpt-4o-mini`);
  `OPENAI_EMBED_MODEL` (default `text-embedding-3-small`, 1536-dim — must match `vector(1536)`).
- **Vector bulk-load procedure (learned the hard way):** with the HNSW index in place, vector
  inserts pay graph maintenance that grows with the index — writes started tripping
  `statement_timeout` past ~30k nodes even at 8 rows/statement. For bulk loads: drop
  `idx_sdr_emb_vec`, run `EMBED_WRITE_BATCH=96 npm run embed:content` (plain heap inserts, ~10×),
  then rebuild the index ONCE. The Supabase dashboard's SQL editor has its own gateway timeout
  (ignores `statement_timeout`) — an HNSW build over the full corpus exceeds it; use IVFFlat
  (`using ivfflat ... with (lists = 100)`, builds in seconds) or run HNSW via a direct DB
  connection. Search works index-less (~5s seq scan) — the agent tolerates it. Deletes on
  `sdr_embeddings` must also be chunked (single-statement bulk deletes time out).
  Grounding fed to models: email bodies are pulled (`hs_email_text` → `email_body`, reply chains
  stripped by `cleanEmailBody`) and BANTIC analysis from the call-scoring tables rides the brief
  prompt (`buildBriefUser`).
- **Timeline grounding gotchas (fixed, don't regress):** `loadTimelineForAccount` must fetch
  newest-first then present chronologically (ascending+limit = the OLDEST slice), must map
  dispositions to labels (models can't read GUIDs), and every jsonb `contains` on `company_ids`
  needs the JSON-string form (`JSON.stringify([id])`) — the raw-array form 400s and graceful
  catches silently returned [].
- **Surface:** `/attention` renders **`AttentionBoardEnhanced`** (smart ranking via `lib/agent/ranking`
  + action tracking; the simpler `AttentionBoard` is the earlier version) — priority/rep filters,
  HubSpot backlinks + `/api/agent/watches`.
- **Activation (one-time):** apply `supabase/sdr_schema.sql` (adds `sdr_activity_content`,
  `sdr_agent_watches`, `sdr_agent_notes`, and the `sdr_save_snapshot` RPC) + set the `OPENAI_API_KEY`
  secret. The `spine-agent` cron then runs every 2 h.

## Derived-metric definitions (`lib/sync/aggregate.ts` unless noted)

- **Temperature** / **Deal Health** — see the temperature + deals conventions above + `lib/sync/temperature.ts`
  / `lib/sync/deal-health.ts`. Two-indicator: Deal Health for accounts with a live deal, Temperature otherwise.
- **Demos scheduled / completed (V3, per period)** (`demoScheduledMs`/`demoCompletedMs`): scheduled =
  the deal entered `discovery_done` within the period; completed = FIRST entry into
  `demo_done`/`demo_accepted`/`in_discussion`. Stage-event-ledger-first, stage-date-column fallback.
  SDR lens keys on `sdr_owner`, AE lens on `hubspot_owner_id` → `PeriodMetrics.demos`.
- **Pipeline segregation (V3, period-independent)** (`computeRepPipeline` → `RepData.pipeline`):
  attributed deals by current stage → active (pre/post-demo) / parked (`future_prospect`) / won
  (incl. `transferred_cs`) / lost, + `by_stage` counts of active deals.
- **Demo-status segmentation** (`lib/sync/segmentation.ts` `segmentAccount`): per owned company from its
  deals' canonical stage keys → Demo Pending (no live deal past Discovery) / Scheduled (meeting booked, +
  at-risk on no-show/reschedule) / Done (demo happened → won); the furthest live deal governs; terminal-only
  deals flag `has_revivable`. `RepData.funnel` counts owned rooftops per bucket.
- **Quality score** (`computeQuality`): weighted 0–100 → A–F, from five sub-scores (conversations,
  depth, persistence, channel balance, deliverability).
- **Coverage** (`computeBookCoverage` → `RepData.book`): owner-attributed, **owner-recency 3-state**
  (`CoverageStatus`: `tapped` = owner worked it ≤60d / `worked_by_other` / `untapped`; GDs flag
  `mixed_owner`) — see the coverage convention above. Owned rooftops roll up to GD/Single units by
  **group association** (`unitKeyFor`). Segmented by GD-level lifecycle (`lifecycle_stage_gd_level` →
  `normalizeGdStage`), market segment, dealership type. Measured over the `COVERAGE_ANCHOR` pull.
- **Monthly new-unique** (`RepData.monthly`): per-account/per-contact first-tap tracked over all
  history; "new in month M" = first ever worked in M. Owned-book scoped.
- **Insights** — `buildInsights` (per-period activity callouts) + `bookInsights` (coverage callouts).

## Refresh workflow

- **First-time setup:** apply `supabase/sdr_schema.sql`, run `npm run verify:schema`, then
  `npm run team:seed` (config → DB roster) and `npm run sync:backfill` once (~35–40 min).
- **Steady state:** the delta runs ~every 15 min via the **self-perpetuating `spine-delta-heartbeat.yml`**
  (self-redispatching loop; `spine-delta.yml` `*/15` is the fallback) — see the sync convention. Reconcile
  nightly (`spine-reconcile.yml`, 06:30 UTC), agent every 2 h (`spine-agent.yml`). The delta writes
  `sdr_snapshots`; the deployed app reads it live (no redeploy needed). Add/remove/re-team people in the
  **admin control center** (`/admin`) — it writes the DB roster and auto-fires a targeted pull for new
  reps; no code change or redeploy needed.
- **Recovery:** `npm run sync:reaggregate` rebuilds the snapshot from the spine (no HubSpot) — use
  after an aggregate change or a `saveSnapshot` timeout.
- **Manual trigger:** `workflow_dispatch` on any workflow, or `GET /api/sync/delta` with
  `Authorization: Bearer $CRON_SECRET`.
- **Legacy:** `data/snapshot.json` is an empty placeholder kept only as the build-time static-import
  last-ditch fallback in `lib/snapshot.ts`. The pre-spine file-snapshot sync (`scripts/sync.ts` +
  `npm run sync` + `sync.yml`) has been removed.
