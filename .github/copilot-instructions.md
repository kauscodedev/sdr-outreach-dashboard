# Copilot Instructions: TrackerAI

This document guides Copilot sessions working in this repository (TrackerAI, formerly the SDR
Outreach Coverage Dashboard). For deeper architecture context — including the salesops ownership
footprint (repo `salesops-lab/sdr-outreach-dashboard`, salesops Vercel project, admin identity
`salesops@spyne.ai`) — see [CLAUDE.md](../CLAUDE.md).

## Quick Reference

| Command | What it does |
|---|---|
| `npm run dev` | Run the dashboard locally on http://localhost:3000 |
| `npm run build` | Production build (includes TypeScript typecheck) |
| `npm run lint` | ESLint on `next/core-web-vitals` config |
| `npm test` | Run all Vitest tests |
| `npm test -- --run tests/temperature.test.ts` | Run a single test file |
| `npm test -- --run -t "pattern"` | Run tests matching a name pattern |
| `npm run sync:delta` | Incremental HubSpot sync (O(changes)); the delta cadence is driven by the self-perpetuating `spine-delta-heartbeat.yml`, not GitHub `schedule:` |
| `npm run sync:backfill` | One-time full pull (~35–40 min; required on first setup) |
| `npm run sync:reconcile` | Nightly drift heal (full owned-book + 7-day activity re-pull) |
| `npm run sync:reaggregate` | Rebuild snapshot from spine without HubSpot (recovery tool; logs raw + gzipped size) |
| `npm run verify:schema` | Verify the `sdr_*` Supabase schema is applied |
| `npm run team:seed` | Seed `sdr_roster`/`sdr_pods`/`sdr_managers` from `config/*.ts` (idempotent) |
| `npm run pull:owner` | Targeted full-history pull for ONE owner (`OWNER_ID=… npm run pull:owner`) |
| `npm run agent:run` | One hot-account agent pass (needs `OPENAI_API_KEY`) |
| `npm run content:backfill` | Opt-in: pull call notes/transcripts/email subjects |

## Project Stack

- **Framework:** Next.js 14 (App Router, React 18)
- **Database:** Supabase Postgres
- **Auth:** Supabase Google SSO (@spyne.ai only)
- **Type checking:** TypeScript (strict mode)
- **Testing:** Vitest (Node environment)
- **Styling:** Tailwind CSS + CSS variables
- **Icons:** Lucide React
- **External API:** HubSpot (change-feed sync), OpenAI (agent reasoning)
- **Node version:** 22+ (hard floor for WebSocket support)

## Build, Test, Lint

- **Dev server:** `npm run dev` → Next.js hot reload on http://localhost:3000
- **Build:** `npm run build` runs the full TypeScript check; there is no separate `tsc` script
- **Linting:** `npm run lint` uses ESLint with `next/core-web-vitals` config
- **Testing:** 
  - Full suite: `npm test`
  - Single file: `npm test -- --run tests/temperature.test.ts`
  - By name: `npm test -- --run -t "temperature"`
  - Watch mode: `npx vitest tests/temperature.test.ts` (drop the `--run`)
- **Test coverage:** `tests/` covers pure logic only — 25 files / 245 tests: US/Eastern bucketing with DST (+ `periodBounds`), aggregation (incl. GD grouping + deal integration + V3 event-truth demos/pipeline + range windows), activity/deal→company association (+ orphan-heal fallback), temperature classification, the canonical deal-stage engine (+ V3 active/parked/demo-completed predicates), stage-event extraction, demo-status segmentation, Deal Health, Forecast v1, integrity checks, the account-timeline builder, the calling drill-down builder, the embedding chunk composer, pod/team filters, call-quality mapping, spine row mappers, RBAC scope decision, agent detector/prompt/ranking, and the auth-domain rule. Never import `server-only` modules in tests; they throw under Vitest.

## Architecture Overview

**Data flow:** HubSpot (change-feed) → Postgres spine (`sdr_*` tables) → aggregate snapshot → snapshot row (cached) → Next.js middleware → authenticated pages

```
GitHub Actions cron (15-min delta / nightly reconcile)
  ↓
lib/spine/runner.ts (orchestrates watermark-driven, advisory-locked, idempotent sync)
  ├─ lib/sync/pull.ts (HubSpot v4 API: activities, companies & deals since watermark)
  ├─ lib/sync/associate.ts (resolve activity/deal→contact→company)
  ├─ lib/spine/store.ts (batch upsert + saveSnapshot — gzip-compressed)
  └─ lib/sync/aggregate.ts (build Snapshot: reach, temperature, Deal Health,
     demo-status segmentation, owner-recency coverage, per-rep funnel, quality)
       ↓
sdr_snapshots (one gzip-compressed jsonb row, id=1) — ONE snapshot, period-independent data model
       ↓
getSnapshot() in lib/snapshot.ts (tries: spine → Vercel Blob → file → empty)
       ↓
middleware.ts (auth gate: Supabase SSO + @spyne.ai domain)
       ↓
app/page.tsx → components/Dashboard.tsx (rep table + Demo funnel + SDR/AE toggle)
app/accounts/* (owned book by demo-status), app/admin/*, app/attention/*, app/api/rep/[ownerId]/*
app/api/rep/[ownerId]/calling → lib/sync/calling.ts buildCallingDetail → components/CallingCard.tsx
  (calling drill-down for ANY period or custom range via periodBounds — spine-read, NOT in the snapshot)
app/api/intel/* (ask · themes · focus · radar) + app/api/agent/actions → lib/intel/* → the
  Intelligence hub at /attention (IntelligenceHub: Ask · Focus · Radar · Themes · Board). Ask =
  tool-loop RAG over sdr_embeddings via sdr_search_content_v2 (selectivity-aware; owner_id-scoped);
  signals mined nightly into sdr_intel_signals (intel:signals, after embed:content)
```

**Key constraint:** The app **never** calls HubSpot at request time. All outreach data is pre-computed and stored in Postgres. Call-quality is read live per request (separate, read-only Supabase tables). Sync runs outside Vercel (GitHub Actions) because it can exceed serverless timeouts.

## Key Conventions

### Snapshot & Time Windows

- **Six US/Eastern periods:** `today`, `yesterday`, `this_week`, `this_month`, `last_week`, `last_month` (DST-aware, weeks start Monday)
- **Snapshot shape:** `Snapshot` → `owner_names`, `owner_kinds` (id→sdr/ae, drives the SDR/AE toggle), `reps[ownerId]` → `{ periods[periodKey]: PeriodMetrics, daily[], book, monthly[], funnel }`
- **Narrow vs. wide periods:** `today`, `yesterday`, `this_week` include `company_breakdown` (detailed accounts + an `AccountDeal` block); others omit it to keep the snapshot small
- **Book coverage:** owner-attributed, **owner-recency 3-state** (`CoverageStatus`: `tapped` = the owner worked it ≤60d / `worked_by_other` = only a different tracked rep did / `untapped`; GD units flag `mixed_owner`). This replaced the old monotonic "ever tapped by anyone" boolean — though Temperature still keys off the all-history "ever tapped" set for its untouched detection (the two notions are intentionally distinct).
- **Monthly new-unique:** per account/contact, first-tap tracked over all history

### Temperature Classification

Located in `lib/sync/temperature.ts` and applied during aggregation. Rules (first match wins):
- **HOT:** meeting scheduled/rescheduled, callback-high, callback-low ×2, email reply
- **WARM:** referral, callback-low ×1, any connect, email open
- **COLD:** no-connect / untouched / disqualified (negative outcome without recent positive signal)

"Connected" is a business rule: only the 11 GUIDs in `config/dispositions.ts` `CONNECTED_DISPOSITIONS` count as reaching a human. Ported verbatim from `call-scoring-agent`; keep in sync.

### Deals, Deal Health & Demo Funnel (V2)

HubSpot **deals** are a first-class object (Auto Pipeline `1001348836` only; everything else → `other`). Because `dealstage` is a flattened enum shared across pipelines where the same label maps to different ids, **all logic keys on the canonical `stageKey(pipeline, dealstage)`** (`config/deal-stages.ts`), never a bare id. Derived per owned company:
- **Demo-status segmentation** (`lib/sync/segmentation.ts`): Demo Pending / Scheduled / Done (+ at-risk/revive flags; the furthest live deal governs). `RepData.funnel` counts owned rooftops per bucket and drives the home-page funnel strip + the SDR/AE toggle.
- **Deal Health** (`lib/sync/deal-health.ts`): green/yellow/red (terminal stages decide on stage alone, else a 14d→yellow / 30d→red recency ladder).

**Two-indicator rule:** accounts *with* a live deal show **Deal Health**; accounts *without* one keep hot/warm/cold **Temperature**. Never merged — a rooftop's `deal.health` is null exactly when Temperature governs, and the UI picks whichever is set.

### Intelligence Layer (V3 P3)

The Deal Funnel view (`/accounts`, `components/DealFunnel.tsx` ← `/api/deals`) shows the stage-wise pipeline over a **90-day deal window** (created-date; 30/90/180/All), with commitment-date columns (SDR `demo_scheduled_for_date`, AE `expected_contract_closure_date` — overdue burns red), **Forecast v1** (`lib/sync/forecast.ts` — resolved-cohort conversion, stage velocity, expected value; thin cohorts show null), and the funnel **ends at Contract Closed** (post-sale stages fold in). `/api/integrity` + `components/admin/IntegrityQueue.tsx` = the read-only data-integrity triage on /admin. The agent (`lib/agent/*`) generates grounded **Account Briefs** via a tool-using loop (`toolloop.ts` — the model must finish via the submit tool, whose args ARE the output) with `search_account_history` semantic recall over `sdr_embeddings` (pgvector; `embed-chunks.ts` decides what earns a vector; email bodies reply-chain-stripped; BANTIC from call-scoring rides the prompt). All jsonb `contains` on `company_ids` need `JSON.stringify([id])`; vector bulk loads: drop the IVFFlat index (`idx_sdr_emb_vec`) → `EMBED_WRITE_BATCH=96` → rebuild once + `analyze sdr_embeddings`.

### Funnel Truth: Stage-Event Ledger (V3)

Period funnel metrics are **event-based, never current-stage-based**. `sdr_deal_stage_events` records when each deal entered/exited each canonical stage (from HubSpot's built-in `hs_v2_date_entered/exited_<stageId>` properties; pure extraction in `lib/sync/stage-events.ts`). **Demos Scheduled** = entered `discovery_done` in the period; **Demos Completed** = FIRST entry into `demo_done`/`demo_accepted`/`in_discussion` (all three count) → `PeriodMetrics.demos`. **Pipeline segregation** (`RepData.pipeline`): active (pre/post-demo) / parked (`future_prospect`) / won (incl. `transferred_cs`) / lost, by current stage. SDRs credited via `sdr_owner`, AEs via `hubspot_owner_id` — two lenses, never summed. `sdr_contact_companies` = explicit contact↔rooftop M:N junction. Both tables degrade gracefully pre-migration; both snapshot fields are optional — guard on pre-V3 snapshots.

### Coverage Attribution

**Load-bearing rule:** Coverage is attributed to the **account owner, not the activity doer** (`lib/sync/aggregate.ts`). Engagement on an owned rooftop rolls up to the owner's book whenever ANY tracked rep works it; the 3-state `CoverageStatus` then distinguishes whether the **owner** worked it ≤60d (`tapped`) or only a *different* tracked rep did (`worked_by_other`). Per-rep period metrics (touches, reach, daily breakdown) stay per activity-doer.

### Roster & Org Structure: DB-backed, admin-editable

The tracked roster + org structure live in the **DB** (`sdr_roster`/`sdr_pods`/`sdr_managers`, ~42 reps), read via `lib/team/load.ts` `loadTeamStructure()`; `getTrackedOwnerIds()` (successor to `REP_OWNER_IDS`) is the `IN` filter for HubSpot searches. `config/reps.ts` + `config/team-structure.ts` are now the **seed + fallback only** (`configTeamStructure()`), used when the DB roster is empty/unreachable. Seed the DB with `npm run team:seed`; add/remove/re-team people in the **admin control center** (`/admin`), which auto-fires a targeted single-owner pull for new reps. Adding a rep still needs history pulled (`sync:backfill`/`sync:reconcile`/`pull:owner`); a delta only catches recently-modified rows. **Never hand-enter owner ids** — resolve by email against `sdr_owners`.

### RBAC & Scope

RBAC is a 3-level focus model over the **DB `TeamStructure`** (SDR → AE pod → Manager, not HubSpot teams). `lib/access/scope.ts` `decideScope()` is pure + unit-tested and takes the structure as a param; `resolveViewer` (`lib/access/resolve.ts`) loads it from the DB and always resolves the login's owner id:
- Admin/leadership → all reps
- AE pod lead (by email) → the pod's SDRs
- Manager/TL (by owner id) → their subtree + self
- Individual SDR → own book
- Else → org-wide (no error; focus model, not confidentiality)

### Snapshot Size Constraint

`sdr_snapshots` is ONE jsonb row, **gzip-compressed** — at ~42 reps the raw snapshot is ~9.5 MB, which tripped Postgres `statement_timeout` on the single-row write. Mitigations:
- `saveSnapshot()` gzip-compresses the row (`packSnapshot` → base64, shape `{__gz,v}`): ~9.5 MB → ~1.7 MB, so the write is small and scales with the roster; `loadSnapshotRow` transparently decompresses (and still reads legacy raw rows)
- `ROOFTOP_CONTACT_CAP` (12 in `aggregate.ts`) bounds contacts per rooftop
- `saveSnapshot()` prefers the `sdr_save_snapshot(jsonb)` RPC, else falls back to a retrying upsert on ANY rpc error
- If aggregate changes enlarge the snapshot: use `npm run sync:reaggregate` (spine-only, logs raw + compressed size)

### 10k Search Ceiling

HubSpot Search API caps results at 10k per call. `lib/sync/pull.ts` handles this by slicing into 7-day windows, resuming from `lastmodified − 1` when a window maxes out. At most `MAX_RESUME_WINDOWS` (3) defers the rest (watermark still advances, no livelock).

### Change-Feed Sync: Watermark-Driven + Idempotent

- **Watermarks** per type in `sdr_sync_state` table
- Each delta re-reads from `watermark − OVERLAP_MS` (5 min overlap)
- All upserts are PK-idempotent (can re-run safely)
- Advances watermark only after upserts + re-aggregate succeed
- Advisory lock (`lock` row) ensures one sync at a time, fenced by lease token
- Nightly reconcile corrects owner-moves; HubSpot deletions are not propagated

### Data Types & Contracts

Shared types across modules:
- `lib/sync/types.ts` — sync ↔ UI contract (activities, companies, contacts, `Deal`, `AccountDeal`, `RepFunnel`, `CoverageStatus`, `DemoStatus`, `DealHealth`)
- `lib/spine/types.ts` — Postgres `sdr_*` rows + `Viewer` type (who sees what, incl. `kind`)
- `config/deal-stages.ts` — canonical deal-stage model (collision-safe `stageKey`)
- `lib/callquality/types.ts` — read-only call-scoring merge (BANTIC, coaching snapshots)
- `lib/agent/types.ts` — AI agent I/O (hot-account detection, reasoning, watches)

## Environment & Secrets

Secrets live **only in `.env.local` (gitignored) and Vercel/GitHub secrets** — never in code.

Required:
- `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (auth)
- `SUPABASE_SERVICE_ROLE_KEY` (server-only: spine + call-quality + agent)
- `HUBSPOT_PAT` (sync scripts)

Optional:
- `CRON_SECRET` (for `/api/sync/delta` route, constant-time check)
- `OPENAI_API_KEY` (agent reasoning; optional model override: `OPENAI_MODEL`, default `gpt-4o-mini`)
- `BLOB_READ_WRITE_TOKEN` (Vercel Blob fallback for snapshot storage)
- `GH_DISPATCH_TOKEN` (GitHub Actions secret — a PAT with `actions:write`; **required** for the delta heartbeat's self-redispatch and the admin add-user owner-pull. Also lives in Vercel env for the server-action path)

**Production fails closed (503)** if `NEXT_PUBLIC_SUPABASE_*` vars are missing. Local dev without them runs ungated, spine/call-quality disabled.

## Development Workflow

1. **Local setup:**
   ```bash
   npm install
   cp .env.local.example .env.local     # add secrets
   npm run verify:schema                # one-time schema check
   npm run team:seed                    # seed the DB roster from config/*.ts
   npm run sync:backfill                # one-time full pull (~35–40 min)
   npm run dev
   ```

2. **Making changes:**
   - **Roster/config:** the tracked roster is DB-backed (edit via `/admin`); `config/reps.ts` is only the seed/fallback. No breaking changes to `config/dispositions.ts` without a reconcile
   - **Aggregate logic:** Changes enlarge snapshot → test locally + watch `npm run sync:reaggregate` output
   - **UI:** Next.js hot reload; snapshots are read live from DB
   - **Auth/RBAC:** the org structure is DB-backed (`sdr_pods`/`sdr_managers`); `decideScope` in `lib/access/scope.ts` is pure — test against `tests/access.test.ts`

3. **Pull requests:**
   - TypeScript must pass: `npm run build`
   - ESLint must pass: `npm run lint`
   - Tests should pass: `npm test`
   - Use descriptive commits with Copilot co-author trailer

## HubSpot API

- **Portal:** 242626590 (app-na2)
- **Deep-link builders:** `config/hubspot.ts` (`companyUrl`, `contactUrl`, `dealUrl`, `meetingUrl`, `callUrl`)
- **Required Private App scopes:** `crm.objects.contacts.read`, `crm.objects.companies.read`, engagement + association read
- **Sync pulls:** outbound calls/emails only (`hs_call_direction=OUTBOUND`, `hs_email_direction=EMAIL`)

## AI Agent Features

The hot-account agent runs every 2 hours (GitHub Actions), reads-only on HubSpot:
- **Detection:** `lib/agent/detect.ts` (pure, unit-tested) — newly-hot / stale / intent-shift accounts
- **Reasoning:** `lib/agent/openai.ts` — OpenAI reasoning over snapshot + call-scoring distilled text
- **Storage:** `sdr_agent_watches` / `sdr_agent_notes` / `sdr_activity_content` tables
- **UI:** `/attention` (`AttentionBoardEnhanced` — smart ranking + action tracking; the simpler `AttentionBoard` is the earlier version) + `/api/agent/watches`
- **Activation:** one-time: apply `supabase/sdr_schema.sql` + set `OPENAI_API_KEY`

## Common Debugging

| Issue | Solution |
|---|---|
| Snapshot timeout on write | `npm run sync:reaggregate` (spine-only, logs size) |
| New rep has no history | `npm run sync:backfill` or `npm run sync:reconcile` (delta only catches modified rows) |
| Dispositions out of sync | Check `config/dispositions.ts` vs. `call-scoring-agent/config/dispositions.py` |
| Auth gate 503 | Verify `NEXT_PUBLIC_SUPABASE_*` env vars in Vercel |
| Sync stuck | Check advisory lock row + lease token in `sdr_sync_state` |

## File Structure Highlights

- `app/` — Next.js App Router (pages, API routes, auth callback)
- `components/` — React client components (Dashboard, RepDrawer, AccountsTable, charts)
- `lib/` — Shared logic
  - `lib/spine/` — data spine orchestration + store
  - `lib/sync/` — HubSpot pull + associate + aggregate + temperature
  - `lib/snapshot.ts` — load from spine / Blob / file
  - `lib/access/` — RBAC scope decision
  - `lib/callquality/` — read-only call-scoring merge
  - `lib/agent/` — AI agent (detect, reason, store)
  - `lib/auth/` — auth domain rule
  - `lib/supabase/` — Supabase client (admin = server-only)
- `config/` — dispositions, HubSpot portal, canonical deal stages (`deal-stages.ts`); `reps`/`team-structure` are the roster seed/fallback (the DB is authoritative)
- `tests/` — Vitest, 25 files / 245 tests, pure logic only (full inventory in CLAUDE.md's Commands section)
- `scripts/` — CLI scripts (sync, agent, verify-schema)
- `supabase/` — SQL schema + RLS floor

## Integration Points

- **HubSpot:** Change-feed via v4 Search API (watermark-driven)
- **Supabase:** Postgres spine + call-scoring tables + Google SSO
- **OpenAI:** Agent reasoning (gpt-4o-mini by default)
- **Vercel:** Deployment + optional Blob snapshot fallback

---

**For deeper context:** See [CLAUDE.md](../CLAUDE.md) for full architecture, data model, and conventions.
