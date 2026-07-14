# Calling Intelligence drill-down — design

**Date:** 2026-07-14 · **Status:** approved (autonomous session; user delegated design: "add and
modify this basis your own thinking")

## Problem

Calling is the team's primary outreach channel, but the Overview page only shows per-rep calling
*aggregates* (dials, connected, connect rate, by-disposition histogram). Managers need the layer
underneath, per rep and per period:

- **Unique contacts called** → which of them *connected* → **who** they are → **what outcome**
- **Unique rooftops called** → who within each rooftop was worked → outcomes
- **Call outcomes** with the actual lists behind every number
- For all six US/Eastern periods: today, yesterday, last 3 days, this week, last week, this month
- Clicking any number opens the underlying contact/company list

Current gaps: contact/company-level drill-down (`company_breakdown`) exists only for the three
narrow periods (snapshot-size guard), is activity-generic rather than calling-first, and no view
answers "who was called and what happened" as a list.

## Approaches considered

1. **Fatten the snapshot** — add per-period calling detail for all six periods.
   Rejected: the one-row jsonb snapshot already required gzip to dodge `statement_timeout` at
   ~9.5 MB; `this_month` contact-level rows × 42 reps would multiply it.
2. **Extend `company_breakdown` to all periods.** Rejected: same size problem, still not
   contact-log-shaped, and couples the feature to snapshot rebuild cadence.
3. **Lazy spine-backed API + pure builder (CHOSEN).** Mirrors `/api/rep/[ownerId]/book` (lazy
   drill-down) and `/api/metrics/range` (read spine at request time, fold through a pure engine).
   No snapshot growth, all six periods + custom from–to ranges, always as fresh as the last delta.

## Design

```
components/Dashboard.tsx (Contacts/Rooftops/Connect cells + KPI tiles → open drawer, focus panel)
  └─ components/CallingCard.tsx  (client; fetch-on-open, tabbed Contacts | Rooftops | Call log,
       funnel strip Dials→Contacts→Connected→Meetings, outcome chips = client-side filters,
       HubSpot deep links, CSV export)
       └─ GET /api/rep/[ownerId]/calling?period=<PeriodKey> | ?from&to=YYYY-MM-DD
            ├─ roster-validated (getTrackedOwnerIds), middleware-gated like all /api
            ├─ periodBounds(period, ctx)      lib/sync/buckets.ts   (pure, DST-aware)
            ├─ loadActivitiesBetween(...)     lib/spine/store.ts    (calls filtered in-route)
            ├─ loadContactMetaFor(ids) + loadCompanyNamesFor(ids)   (targeted chunked reads)
            └─ buildCallingDetail(...)        lib/sync/calling.ts   (pure, unit-tested)
```

### 1. `periodBounds(period, ctx)` — lib/sync/buckets.ts

Inverse of `periodsForActivity`: the `[fromMs, toMs)` UTC window for each of the six periods,
built from the same civil-ordinal + `etMidnightUtcMs` primitives (DST-safe). Consistency property
(tested): for every ts in bounds, `periodsForActivity(ts, ctx)` contains the period, and vice
versa for past timestamps. Also extract the range route's local `etDayMs` helper into buckets as
`etDayStartMs` so the calling route and range route share one implementation.

### 2. `buildCallingDetail(calls, contactMeta, companyNames)` — lib/sync/calling.ts (pure)

Input: call activities only (route filters `type === "call"`). Output `CallingDetail`:

- `summary`: dials, connected calls, no-disposition count, connect rate (null-disposition excluded
  from denominator, matching the existing business rule), unique contacts called / connected,
  unique rooftops called / connected, meetings booked, unattributed calls.
- `outcomes[]`: per disposition label — count, unique contacts, connected flag. Sorted by count.
- `contacts[]`: one row per unique contact called — name/title/DM (from `sdr_contacts` meta),
  company (from the call's association), dials, connected count, per-outcome counts, last call
  time + last outcome. Sorted by dials desc.
- `rooftops[]`: one row per unique company called — dials, connected, meetings, contacts-called
  count, nested contact rows (who within the rooftop), last call time. Sorted by dials desc.
- `log[]`: newest-first flat call log (ts, contact, company, outcome, connected), capped at 800
  rows (`summary.calls` keeps the true total).

Attribution notes: a call with multiple companies counts once per company (same as the aggregate
engine); a call with no company lands in `unattributed_calls` and appears in contacts/log with a
"—" company. "Rooftop connected" = ≥1 connected call on it in the period.

### 3. Route — app/api/rep/[ownerId]/calling/route.ts

`?period=` (one of the six keys, computed against `Date.now()`) or `?from&to` (mirrors the range
route validation: YYYY-MM-DD, inclusive, ≤190 days). 404 on untracked owner. `force-dynamic`.

### 4. UI

- **CallingCard** sits in the rep drawer (Scorecard) directly under the KPI strip — where the
  period context already lives. Lazy-fetches when the drawer opens; refetches on period/range
  change. Funnel tiles and outcome chips filter the active tab client-side. Contact/company/call
  rows deep-link to HubSpot (`contactUrl`/`companyUrl`/`callUrl`). CSV export of the contacts tab.
- **Overview entry points**: the Contacts and Rooftops cells and the Connect cell in each rep row
  become click targets (stopPropagation) that open the drawer with the CallingCard focused on the
  matching tab; the KPI "Calls" tile inside the drawer scrolls to the card.

### Testing

`tests/buckets.test.ts` gains periodBounds cases (fixed dates incl. DST weeks, consistency with
periodsForActivity). New `tests/calling.test.ts` covers the pure builder: uniqueness, connected
classification, outcome grouping, per-rooftop nesting, unattributed handling, log cap + ordering.
Route and UI follow existing untested-shell conventions (thin assembly over tested pure logic).

## Out of scope (follow-ups)

- Emails in the drill-down (calling-first by explicit user framing; the builder's shape leaves
  room for an `emails` facet later).
- Team-level rollup of the calling detail (open per rep from the Overview row for now).
- Call recordings/transcript links in the log (needs `sdr_activity_content` join — cheap later).
