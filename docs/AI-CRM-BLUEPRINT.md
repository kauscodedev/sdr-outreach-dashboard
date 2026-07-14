# TrackerAI V3 — AI CRM Blueprint

**Date:** 2026-07-13 · **Status:** SHIPPED through P3 (2026-07-14) · **Author:** Kaustubh + Claude
**Reframe:** TrackerAI graduates from *activity tracker* to **AI CRM** — HubSpot stays the
system of record; TrackerAI becomes the **system of intelligence**: the opinionated read
model + funnel truth + AI copilot that sales leadership actually runs the motion from.

## Implementation status (2026-07-14)

| Phase | Status | Highlights |
|---|---|---|
| **P0 — Event foundation** | ✅ shipped + activated | `sdr_deal_stage_events` ledger (17k+ events from `hs_v2_date_entered_*`), `sdr_contact_companies` M:N junction, `isActive`/`isParked`/`isDemoCompletedStage` predicates |
| **P1 — Funnel truth** | ✅ | Period demos scheduled/completed (event-based), `RepData.pipeline` active/parked/won/lost, Demos column + per-rep funnel cells on Overview |
| **P2 — Navigation & drill** | ✅ | Pod/team filter, from–to range API (`/api/metrics/range`), column filters, account History panel + unified timeline |
| **Deal Funnel page** | ✅ (user-directed: lives at `/accounts`) | 3-lane stage funnel + flow conversion, 90-day window (deals created), Demo-date + Expected-close commitment columns, funnel truncated at Contract Closed, sortable workbench, All-reps scope |
| **P3 — Intelligence** | ✅ | Forecast v1 (resolved-cohort conversion + velocity + expected value), integrity queue on /admin (orphans/slipped demos/stale/mismatch/regression), grounded Account Briefs, pgvector recall over the 65,869-vector content corpus (calls + email BODIES + BANTIC), tool-using agent loop (`toolloop.ts`, search + submit pattern) |
| **P4 — Automation** | ⏳ next | Guarded HubSpot write-back (candidate #1: repair ~3,600 orphan deal/contact→company associations; #2: brief next-steps as tasks), Slack digests, meetings as a third spine activity type |

Decisions locked (former §10): **A** — Demos Completed includes all three stages (Demo Done /
Accepted / In Discussion). **B** — `future_prospect` is parked. **C** — deals are created at
Discovery Call Done (verified: `hs_v2` entered == createdate); count by stage entry. **D** —
write-back approved under strict guardrails (P4). Additional locked call: the funnel tracks
deals only **until Contract Closed** (HubSpot post-sale data is unreliable).

---

## 1. Vision & product thesis

**One sentence:** *Every owned account, placed precisely in the lead→demo→closure motion,
with the evidence of how it got there and an AI-grounded recommendation of what happens next.*

Three product laws that resolve every design question below:

1. **Event truth over state truth.** A CRM answers "what happened in period P", not just
   "what is true right now". Every funnel metric is defined over *stage-transition events*,
   never over current stage alone.
2. **Two motions, one spine.** SDRs own lead→demo; AEs own demo→closure. Same objects, two
   lenses — never a merged metric that means nothing to either role.
3. **AI is grounded or it is silent.** Every AI claim cites the activity/transcript/stage
   event it derived from. No vibes.

---

## 2. Core object model (data clarity & integrity)

| Object | Table (exists ✅ / new 🆕) | Key relationships & integrity rules |
|---|---|---|
| **Rooftop** (company) | ✅ `sdr_companies` | Belongs to ≤1 GD (`gd_id`); has ≤1 owner. Deals attach here. |
| **Group Dealership** | ✅ derived (`gd_id`/`group_name` on companies) | 1→N rooftops. Unit classification by *group association*, not `is_group` (existing `unitKeyFor` rule). `mixed_owner` flagged when rooftops span owners. |
| **Contact** | ✅ `sdr_contacts` + 🆕 `sdr_contact_companies` | **M:N to rooftops** — today the contact→rooftop link exists only implicitly via activity `contact_ids`/`company_ids` arrays. Add an explicit junction (HubSpot v4 associations, `is_primary` flag). Unlocks GD-level DM-reach dedupe and per-contact journeys. |
| **Deal** | ✅ `sdr_deals` + 🆕 `sdr_deal_stage_events` | Created at rooftop level. Dual ownership already modeled: `deal_owner_id` (AE) + `sdr_owner_id` (SDR). Auto Pipeline only; all logic on canonical `stageKey` (existing `config/deal-stages.ts`). **New: the stage-event ledger** (§3). |
| **Activity** | ✅ `sdr_activities` | Doer (`owner_id`) ≠ account owner — attribution rule stays: period metrics → doer; book/coverage → owner. 🆕 derived **deal attribution**: an activity belongs to a deal when company matches and `ts_ms` falls in the deal's open window. |
| **Rep / Team** | ✅ `sdr_roster`, `sdr_pods`, `sdr_managers` | SDR → AE pod → Manager (existing `TeamStructure`). Powers the new pod/team filters. |
| **Insight / Watch** | ✅ `sdr_agent_watches/notes` + 🆕 `sdr_account_briefs`, `sdr_embeddings` | The AI layer's outputs (§7). |

### The keystone: `sdr_deal_stage_events` 🆕

```sql
create table sdr_deal_stage_events (
  deal_id     text not null references sdr_deals(hs_id),
  stage_key   text not null,          -- canonical DealStageKey
  entered_ms  bigint not null,
  exited_ms   bigint,                 -- null = still in stage
  source      text not null default 'hs_v2',
  primary key (deal_id, stage_key, entered_ms)
);
create index on sdr_deal_stage_events (stage_key, entered_ms);
```

**Populate from HubSpot's built-in calculated properties** `hs_v2_date_entered_<stageId>` /
`hs_v2_date_exited_<stageId>` (exist automatically for every pipeline stage — no property-history
API needed). Add ~30 property names to the existing `pullChangedDeals` request; backfill is one
targeted re-pull. This generalizes the two hardcoded columns we already keep
(`discovery_done_ms`, `demo_done_ms`) into the full ledger.

**Unlocks:** period-scoped funnel counts (§3), stage velocity, conversion rates, forecasting,
stale-deal SLAs — the entire V3 metric layer hangs off this one table.

---

## 3. Canonical funnel metrics (the definitions, locked)

All defined over stage events, pipeline = Auto, scoped by role ownership. Names ↔ canonical keys:
`discovery_done` = "Discovery Call Done", `demo_accepted` = "Demo Accepted",
`in_discussion` = "In Discussion".

| Metric | Definition (period P) | Scoping |
|---|---|---|
| **Demos Scheduled** (SDR) | deals with `entered(discovery_done) ∈ P` | `sdr_owner_id` = rep |
| **Demos Completed** | deals with first `entered(demo_accepted ∪ in_discussion) ∈ P` *(open question A: include `demo_done` stage?)* | SDR lens: `sdr_owner_id`; AE lens: `deal_owner_id` |
| **AE pre-demo** | identical to SDR definitions (aligned by design) | `deal_owner_id` |
| **AE post-demo pipeline** | live deals currently at `demo_accepted → contract_initiated`, until `contract_closed`/`payment_completed` | `deal_owner_id` |
| **Active deal** | not in {`drop_off_sdr`, `drop_off_sales`, `non_sal`, `other`} and not terminal-won. SDR-active: stage ≤ `demo_rescheduled`. AE-active: stage ∈ post-demo, pre-terminal. *(open question B: `future_prospect` — active or parked?)* | new `isActive(key, lens)` predicate beside `isWon`/`isLost` in `config/deal-stages.ts` |
| **Inactive deal** | lost set, OR stale: no stage event and no attributed activity for 30d (reuses Deal Health's red ladder) | both lenses |

**Two funnels, rendered separately:**
- **Lead→Demo (SDR):** owned rooftops → tapped (60d owner-recency, existing) → connected →
  deal created → **Demos Scheduled** → **Demos Completed**.
- **Demo→Closure (AE):** Demos Completed → `in_discussion` → `contract_initiated` →
  `contract_closed` → `payment_completed`, with drop-off (`drop_off_sales`) as exit lane.

Existing `segmentAccount` (demo-status buckets) stays for *account* segmentation; the new
event-metrics power *period* counts. Both keep flowing from the same canonical stage model —
one vocabulary, zero drift.

---

## 4. Navigation & filtering

| Feature | Design | Build note |
|---|---|---|
| **Pod / Team filter** | New dropdown beside the existing All/SDRs/AEs toggle: AE Pods + SDR teams (manager subtrees) from `TeamStructure`. Filters the rep table + all tiles client-side. | Data already loaded server-side for RBAC (`lib/team/load.ts`); pass pod list into page props. UI-only otherwise. |
| **Date-range picker (from–to)** | Calendar popover beside period chips; selecting a range deselects chips and swaps data source from snapshot to a range API. | 🆕 `/api/metrics/range?owners=&from=&to=` — reads `sdr_activities` (+ stage events) and **reuses the existing pure aggregation functions** from `lib/sync/aggregate.ts`. Needs one index: `(owner_id, ts_ms)`. Volumes are small enough for Node-side aggregation; no snapshot changes. |
| **Book Explorer header filters** | Filter popover per column (Stage, Segment, Coverage, Temp, Demo status, Deal health, Last activity) in `UnitsTable`/`RooftopsTable`. Client-side — the full unit set is already lazy-loaded via `/api/rep/[ownerId]/book`. | Pure UI over `BookUnitDetail[]`. Add filter-chip row showing active filters. |

---

## 5. Accounts page & homepage drill-down

1. **Rep-wise stage summary on the homepage:** add per-rep funnel columns (Pending / Scheduled
   / Done / At-risk) to the Overview rep table — `RepData.funnel` already carries these counts
   per rep; today they're only aggregated in the strip. Each cell links to
   `/accounts?rep=<ownerId>&status=<bucket>`.
2. **Accounts page keeps GD → Rooftop → Contact nesting** (exists in `AccountsTable`) and gains:
   pod/team + date-range filters (§4), column filters, and virtualized rows (43 reps × 12.7k
   accounts needs windowing — `@tanstack/react-virtual`, no design change).
3. **Account side panel (new):** clicking a rooftop opens a unified panel — identity + owner,
   demo status + Deal Health/Temp, the **activity timeline** (§6), the deal's stage-event
   history as a mini journey bar, and the AI brief (§7). This becomes the single
   "everything about this account" surface for reps, managers, and admins.

---

## 6. Activity intelligence (who, when, outcome, next step)

- **Three attribution levels from one table:** `sdr_activities` already carries
  `contact_ids` + `company_ids` per activity; deal-level attaches via the derived rule (§2).
  No new pulls needed for v1.
- **Timeline view:** merged calls / emails / stage events / agent notes, newest-first, grouped
  by contact, color-coded SDR vs AE via `owner_kinds`. Each row: who → whom, channel, outcome
  (disposition label), and the next-step if an agent watch exists. Reuse `lib/agent/timeline.ts`
  as the assembly layer; render in the account side panel.
- **SDR vs AE split everywhere:** every activity metric filterable by doer kind — trivially,
  since `owner_kinds` is already in the snapshot.

---

## 7. AI layer overhaul — "Attention" → **Intelligence**

Current agent: gpt-4o-mini, one stuffed prompt per hot account, 25/run. V3 makes it a grounded,
tool-using layer:

1. **RAG over the content you already collect.** `sdr_activity_content` (call notes,
   transcripts, email subjects) → chunk → embed → **pgvector on the same Supabase**
   (`sdr_embeddings`). Retrieval at reasoning time replaces prompt-stuffing; the agent
   synthesizes *actual conversations*, not metadata.
2. **Account Briefs (nightly, per active account):** summary, stakeholders touched, buying
   signals, objections, recommended next step — each bullet citing its source activity id.
   Stored in `sdr_account_briefs`, rendered in the side panel and Intelligence page.
3. **Tool-using agent, not prompt-stuffing:** give the reasoner read tools — query spine,
   fetch content chunks, read stage events — an agentic-RAG loop instead of one giant context.
   Keep `lib/agent/openai.ts` but extract a provider interface; **evaluate Claude
   (claude-sonnet-5 for briefs, claude-haiku-4-5 for cheap classification passes)** — long
   context + citation discipline suit transcript synthesis.
4. **Forecasting v1 (heuristic, not ML):** from the stage-event ledger compute per-stage
   conversion rates and median stage velocity (by segment); expected pipeline =
   Σ amount × historical conversion from current stage. Per AE / pod / org. Honest error bars;
   upgrade to a model only when the ledger has months of history.
5. **Data-integrity agent:** nightly checks — deal missing company association, SDR-owner vs
   company-owner mismatch, GD `mixed_owner`, stage regression, scheduled demo whose date passed,
   contact linked to zero rooftops. Output = triage queue in Admin with an AI-suggested
   resolution. **Read-only suggestions first; guarded HubSpot write-back is P4** (open question D).

---

## 8. Information architecture & roles

**Nav:** Overview · **Pipeline** (new) · Accounts · **Intelligence** (Attention, overhauled) · Admin.

| Role | Default lens |
|---|---|
| SDR | Own book; Pipeline = lead→demo funnel; Targets = demo-pending hot/warm + priority untapped |
| AE | Pod book; Pipeline = demo→closure with active/inactive split; Targets = post-demo deals needing motion (at-risk first) |
| Manager | Subtree rollup; rep-wise stage matrix; velocity + conversion trends |
| Admin | Everything + integrity queue + sync health (existing) |

Focus model stays (everyone keeps "All reps") — RBAC scoping is unchanged (`decideScope`).

---

## 9. Roadmap (dependency-ordered)

| Phase | Scope | Key files | Effort |
|---|---|---|---|
| **P0 — Event foundation** | `sdr_deal_stage_events` (schema + pull `hs_v2_date_entered_*` + backfill), `sdr_contact_companies` junction, `(owner_id, ts_ms)` index, `isActive` predicate, deal-activity derivation. Tests for all pure logic. | `supabase/sdr_schema.sql`, `lib/sync/pull.ts`, `lib/spine/store.ts`, `config/deal-stages.ts` | ~1–2 wk |
| **P1 — Funnel truth** | Period-scoped Demos Scheduled/Completed, active/inactive segregation, AE deal-owner rollup in aggregator, Pipeline page v1, per-rep funnel columns on Overview | `lib/sync/aggregate.ts`, new `app/pipeline`, `components/Dashboard.tsx` | ~1 wk |
| **P2 — Navigation & drill** | Pod/team filter, date-range API + picker, Book Explorer column filters, account side panel + timeline | new `/api/metrics/range`, `components/Accounts*.tsx`, `lib/agent/timeline.ts` | ~1–1.5 wk |
| **P3 — Intelligence** | pgvector + embeddings pipeline, Account Briefs, tool-using agent + provider abstraction, forecast v1, integrity queue (read-only) | `lib/agent/*`, `supabase/sdr_schema.sql` | ~2 wk |
| **P4 — Automation** | Guarded HubSpot write-back (tasks/notes), Slack digests, auto-prioritized daily call lists | new | on demand |

Each phase ships independently and degrades gracefully (the established pattern — e.g. deals
pre-migration). P0 is the only blocking dependency; P1–P3 can interleave.

---

## 10. Open decisions (answers refine P0/P1)

- **A. "Demos Completed" stage set** — strictly `demo_accepted` / `in_discussion` (your words),
  or also the pipeline's `demo_done` stage? The pipeline has all three; today's POST_DEMO
  includes `demo_done`.
- **B. `future_prospect`** — active (in AE pipeline) or parked (excluded from active counts)?
- **C. "Deals created with stage discovery_done"** — recommend counting by *date entered
  discovery_done* (stage event), not deal createdate, since deals are often created at MQL and
  advanced later. Confirm.
- **D. Write-back appetite** — is guarded HubSpot write (tasks, notes, stage suggestions) in
  scope for P4, or does TrackerAI stay read-only permanently?

---

*Repo note: this repo is public — this doc describes internal process. Commit deliberately,
or keep it untracked / move to a private location.*
