/**
 * Pull outbound calls + emails for the tracked owners over the window.
 *
 * Defeats the HubSpot Search API's 10,000-result ceiling by slicing the window
 * into weekly sub-windows sorted ascending by hs_timestamp — each weekly slice
 * is well under 10k at this team's volume, so no slice can silently truncate.
 * Per-slice counts are logged and a slice nearing the ceiling is warned about.
 */

import { hubspotPost, hubspotGet, RATE_LIMIT_DELAY_MS, delay } from "../hubspot/client";
import { getTrackedOwnerIds } from "../team/load";
import { ActivityType, DealStageEvent } from "./types";
import { STAGE_DATE_PROPERTIES, stageEventsOf } from "./stage-events";
import { AUTO_PIPELINE_ID } from "../../config/deal-stages";

const DAY_MS = 86_400_000;
const SLICE_MS = 7 * DAY_MS;
const CEILING_WARN = 9000; // warn if a slice approaches the 10k cap

interface HsRecord {
  id: string;
  properties: Record<string, string | null>;
}

interface SearchResponse {
  total?: number;
  results: HsRecord[];
  paging?: { next?: { after?: string } };
}

interface PullConfig {
  objectType: "calls" | "emails";
  directionProperty: string;
  directionValue: string;
  properties: string[];
}

const CALL_CONFIG: PullConfig = {
  objectType: "calls",
  directionProperty: "hs_call_direction",
  directionValue: "OUTBOUND",
  properties: [
    "hs_timestamp",
    "hubspot_owner_id",
    "hs_call_direction",
    "hs_call_disposition",
    "hs_call_status",
    "hs_call_duration",
    "hs_object_id",
    "hs_lastmodifieddate",
  ],
};

const EMAIL_CONFIG: PullConfig = {
  objectType: "emails",
  directionProperty: "hs_email_direction",
  directionValue: "EMAIL", // "Outgoing"
  properties: [
    "hs_timestamp",
    "hubspot_owner_id",
    "hs_email_direction",
    "hs_email_status",
    "hs_email_open_count",
    "hs_email_click_count",
    "hs_email_reply_count",
    "hs_object_id",
    "hs_lastmodifieddate",
  ],
};

async function pullSlice(cfg: PullConfig, startMs: number, endMs: number, ownerIds: string[]): Promise<HsRecord[]> {
  const collected: HsRecord[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            { propertyName: "hubspot_owner_id", operator: "IN", values: ownerIds },
            { propertyName: cfg.directionProperty, operator: "EQ", value: cfg.directionValue },
            { propertyName: "hs_timestamp", operator: "GTE", value: String(startMs) },
            { propertyName: "hs_timestamp", operator: "LT", value: String(endMs) },
          ],
        },
      ],
      sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
      properties: cfg.properties,
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotPost<SearchResponse>(`/crm/v3/objects/${cfg.objectType}/search`, body);
    collected.push(...res.results);
    after = res.paging?.next?.after;
    await delay(RATE_LIMIT_DELAY_MS);
  } while (after);

  return collected;
}

async function pullObject(cfg: PullConfig, windowStartMs: number, nowMs: number, ownerIds: string[]): Promise<HsRecord[]> {
  const all: HsRecord[] = [];
  const seen = new Set<string>();

  for (let sliceStart = windowStartMs; sliceStart < nowMs; sliceStart += SLICE_MS) {
    const sliceEnd = Math.min(sliceStart + SLICE_MS, nowMs);
    const records = await pullSlice(cfg, sliceStart, sliceEnd, ownerIds);

    let added = 0;
    for (const r of records) {
      if (seen.has(r.id)) continue; // de-dupe across slice boundaries
      seen.add(r.id);
      all.push(r);
      added++;
    }

    const from = new Date(sliceStart).toISOString().slice(0, 10);
    const to = new Date(sliceEnd).toISOString().slice(0, 10);
    console.log(`  [${cfg.objectType}] ${from}..${to}: ${records.length} records (+${added} new)`);
    if (records.length >= CEILING_WARN) {
      console.warn(
        `  ⚠️  [${cfg.objectType}] slice ${from}..${to} returned ${records.length} — approaching the 10k Search ceiling. Consider a finer slice.`,
      );
    }
  }

  return all;
}

export interface RawActivity {
  id: string;
  type: ActivityType;
  ownerId: string;
  timestampMs: number;
  disposition: string | null;
  emailStatus: string | null;
  emailOpened: boolean;
  emailReplied: boolean;
  emailClicked: boolean;
  lastModifiedMs?: number;
}

const num = (v: string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function toMs(hsTimestamp: string | null): number {
  if (!hsTimestamp) return NaN;
  // hs_timestamp comes back as epoch-ms string or ISO string depending on API.
  const n = Number(hsTimestamp);
  if (!Number.isNaN(n) && n > 0) return n;
  return new Date(hsTimestamp).getTime();
}

export interface OwnedCompany {
  id: string;
  name: string;
  gdStage: string | null; // lifecycle_stage_gd_level — the GD-level pipeline stage
  lifecycleStage: string | null; // lifecyclestage — the company-level lifecycle stage
  gdId: string | null; // gd_id — rooftop → Group Dealership key
  isGroup: boolean; // is_this_is_a_part_of_group_dealership_ === "true"
  groupName: string | null; // dealership_group_name (human label)
  segment: string | null; // market_segment (size bucket)
  dealershipType: string | null; // type_of_dealership (Franchise / Independent)
  lastActivityMs: number | null; // notes_last_updated — any-activity last-touch (company level)
  rooftopLastActivityMs: number | null; // rooftop_last_activity — GD/rooftop-level last activity
}

/**
 * Pull each rep's owned company book (company owner = rep) — the coverage
 * denominator. Searched per-owner so no single query approaches the 10k ceiling,
 * and names come back in the search (no separate name lookup needed).
 */
export async function pullOwnedCompanies(ownerIdsOverride?: string[]): Promise<Record<string, OwnedCompany[]>> {
  const out: Record<string, OwnedCompany[]> = {};
  const ownerIds = ownerIdsOverride ?? await getTrackedOwnerIds();
  console.log("Pulling owned-company books (coverage denominator)…");

  for (const ownerId of ownerIds) {
    const companies: OwnedCompany[] = [];
    let after: string | undefined;
    do {
      const body: Record<string, unknown> = {
        filterGroups: [{ filters: [{ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }] }],
        sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
        properties: [
          "name", "lifecycle_stage_gd_level", "lifecyclestage", "gd_id",
          "is_this_is_a_part_of_group_dealership_", "dealership_group_name",
          "market_segment", "type_of_dealership",
          "notes_last_updated", "rooftop_last_activity",
        ],
        limit: 100,
      };
      if (after) body.after = after;
      const res = await hubspotPost<SearchResponse>(`/crm/v3/objects/companies/search`, body);
      for (const r of res.results) {
        companies.push({
          id: r.id,
          name: r.properties.name?.trim() || `Company ${r.id}`,
          gdStage: r.properties.lifecycle_stage_gd_level?.trim() || null,
          lifecycleStage: r.properties.lifecyclestage?.trim() || null,
          gdId: r.properties.gd_id?.trim() || null,
          isGroup: r.properties.is_this_is_a_part_of_group_dealership_ === "true",
          groupName: r.properties.dealership_group_name?.trim() || null,
          segment: r.properties.market_segment?.trim() || null,
          dealershipType: r.properties.type_of_dealership?.trim() || null,
          lastActivityMs: toMs(r.properties.notes_last_updated ?? null) || null,
          rooftopLastActivityMs: toMs(r.properties.rooftop_last_activity ?? null) || null,
        });
      }
      after = res.paging?.next?.after;
      await delay(RATE_LIMIT_DELAY_MS);
    } while (after);

    out[ownerId] = companies;
    if (companies.length >= CEILING_WARN) {
      console.warn(`  ⚠️  owner ${ownerId} owns ${companies.length} companies — near the 10k Search ceiling.`);
    }
  }

  const total = Object.values(out).reduce((a, c) => a + c.length, 0);
  console.log(`  owned companies: ${total} across ${ownerIds.length} reps.`);
  return out;
}

export interface PullCaps {
  calls: boolean;
  emails: boolean;
}

/**
 * Map raw HubSpot records (calls and emails mixed) to RawActivity.
 * A record is a call iff it carries hs_call_direction — the call search filters
 * on it and CALL_CONFIG requests it, so calls always have it; emails never do.
 * Drops anything we can't time-bucket or attribute to a tracked owner.
 */
function normalizeRecords(records: HsRecord[]): RawActivity[] {
  const activities: RawActivity[] = [];

  for (const r of records) {
    const isCall = r.properties.hs_call_direction != null;
    if (isCall) {
      activities.push({
        id: r.id,
        type: "call",
        ownerId: r.properties.hubspot_owner_id ?? "",
        timestampMs: toMs(r.properties.hs_timestamp),
        disposition: r.properties.hs_call_disposition ?? null,
        emailStatus: null,
        emailOpened: false,
        emailReplied: false,
        emailClicked: false,
        lastModifiedMs: toMs(r.properties.hs_lastmodifieddate ?? null) || undefined,
      });
    } else {
      activities.push({
        id: r.id,
        type: "email",
        ownerId: r.properties.hubspot_owner_id ?? "",
        timestampMs: toMs(r.properties.hs_timestamp),
        disposition: null,
        emailStatus: r.properties.hs_email_status ?? null,
        emailOpened: num(r.properties.hs_email_open_count) > 0,
        emailReplied: num(r.properties.hs_email_reply_count) > 0,
        emailClicked: num(r.properties.hs_email_click_count) > 0,
        lastModifiedMs: toMs(r.properties.hs_lastmodifieddate ?? null) || undefined,
      });
    }
  }

  // Drop anything we can't time-bucket or attribute to a tracked owner.
  return activities.filter((a) => a.ownerId && Number.isFinite(a.timestampMs) && a.timestampMs > 0);
}

/** Pull outbound calls + emails (whichever the token can read), normalized. */
export async function pullActivities(
  windowStartMs: number,
  nowMs: number,
  caps: PullCaps,
  ownerIdsOverride?: string[],
): Promise<RawActivity[]> {
  let calls: HsRecord[] = [];
  let emails: HsRecord[] = [];

  const ownerIds = ownerIdsOverride ?? await getTrackedOwnerIds();
  if (caps.calls) {
    console.log("Pulling outbound calls…");
    calls = await pullObject(CALL_CONFIG, windowStartMs, nowMs, ownerIds);
  } else {
    console.warn("Skipping calls — no read access.");
  }
  if (caps.emails) {
    console.log("Pulling outgoing emails…");
    emails = await pullObject(EMAIL_CONFIG, windowStartMs, nowMs, ownerIds);
  } else {
    console.warn("Skipping emails — no read access (scope: connected-email-data-access).");
  }

  const trackable = normalizeRecords([...calls, ...emails]);
  console.log(`Pulled ${calls.length} calls + ${emails.length} emails = ${trackable.length} usable activities.`);
  return trackable;
}

const DELTA_CEILING = 9800; // cut a modified-window short of the 10k Search cap
const MAX_RESUME_WINDOWS = 3; // livelock guard: bounded catch-up per run; the watermark still advances, so successive runs drain the backlog

/** One page-loop pull of records modified strictly after `sinceMs`, ascending by
 *  lastmodified. `sawCeiling` is set only when the window filled AND more pages
 *  remain — the caller then resumes with a later cursor. */
async function pullModifiedSlice(
  objectType: string,
  extraFilters: object[],
  properties: string[],
  sinceMs: number,
  ownerIds: string[],
  ownerProperty = "hubspot_owner_id",
): Promise<{ records: HsRecord[]; sawCeiling: boolean }> {
  const collected: HsRecord[] = [];
  let after: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: [
        { propertyName: ownerProperty, operator: "IN", values: ownerIds },
        ...extraFilters,
        { propertyName: "hs_lastmodifieddate", operator: "GT", value: String(sinceMs) },
      ] }],
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
      properties,
      limit: 100,
    };
    if (after) body.after = after;
    const res = await hubspotPost<SearchResponse>(`/crm/v3/objects/${objectType}/search`, body);
    collected.push(...res.results);
    after = res.paging?.next?.after;
    await delay(RATE_LIMIT_DELAY_MS);
    if (after && collected.length >= DELTA_CEILING) return { records: collected, sawCeiling: true }; // progressive catch-up
  } while (after);
  return { records: collected, sawCeiling: false };
}

/** Ceiling-resume loop shared by the delta pulls. Resumes from lastMs − 1
 *  (GTE-equivalent: the GT filter would otherwise skip records sharing the
 *  boundary millisecond — callers absorb the re-reads via dedupe) and caps
 *  catch-up at MAX_RESUME_WINDOWS windows per run so an oversized backlog
 *  can't outlive the job time limit. */
async function pullModifiedWithResume(
  objectType: string,
  extraFilters: object[],
  properties: string[],
  sinceMs: number,
  ownerIds: string[],
  onRecord: (r: HsRecord) => void,
  ownerProperty = "hubspot_owner_id",
  maxWindows = MAX_RESUME_WINDOWS,
): Promise<void> {
  let cursor = sinceMs;
  for (let window = 1; ; window++) {
    const { records, sawCeiling } = await pullModifiedSlice(objectType, extraFilters, properties, cursor, ownerIds, ownerProperty);
    for (const r of records) onRecord(r);
    if (!sawCeiling) return;
    if (window >= maxWindows) {
      console.warn(`[delta] ${objectType} backlog remains after ${maxWindows} catch-up windows — will continue next run`);
      return;
    }
    const lastMs = toMs(records[records.length - 1].properties.hs_lastmodifieddate ?? null);
    let next = lastMs > 0 ? lastMs - 1 : cursor + 1;
    if (next <= cursor) {
      // Only reachable if >DELTA_CEILING records share one millisecond — force
      // progress past the tie (those tied records may be skipped).
      console.warn(`  ⚠️  [${objectType}] no cursor progress at ${new Date(cursor).toISOString()} — forcing +1ms`);
      next = cursor + 1;
    }
    cursor = next;
    console.warn(`  [${objectType}] delta hit 10k window — resuming from ${new Date(cursor).toISOString()}`);
  }
}

/** Changed outbound activities since watermarks (per type). O(changes). */
export async function pullChangedActivities(
  sinceCallsMs: number, sinceEmailsMs: number, caps: PullCaps,
): Promise<RawActivity[]> {
  const out: HsRecord[] = [];
  const seen = new Set<string>();
  const ownerIds = await getTrackedOwnerIds();
  const collect = (r: HsRecord) => { if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } };
  const run = (cfg: PullConfig, since: number) => pullModifiedWithResume(
    cfg.objectType,
    [{ propertyName: cfg.directionProperty, operator: "EQ", value: cfg.directionValue }],
    cfg.properties, since, ownerIds, collect,
  );
  if (caps.calls) await run(CALL_CONFIG, sinceCallsMs);
  if (caps.emails) await run(EMAIL_CONFIG, sinceEmailsMs);
  return normalizeRecords(out);
}

const COMPANY_DELTA_PROPERTIES = [
  "name", "lifecycle_stage_gd_level", "lifecyclestage", "gd_id", "is_this_is_a_part_of_group_dealership_",
  "dealership_group_name", "market_segment", "type_of_dealership",
  "notes_last_updated", "rooftop_last_activity", "hubspot_owner_id", "hs_lastmodifieddate",
];

/** Companies owned by tracked reps changed since `sinceMs` (owner moves INTO book, edits).
 *  Boundary re-reads can duplicate records — the store's in-batch last-wins dedupe absorbs them. */
export async function pullChangedCompanies(sinceMs: number): Promise<(OwnedCompany & { ownerId: string; lastModifiedMs: number })[]> {
  const out: (OwnedCompany & { ownerId: string; lastModifiedMs: number })[] = [];
  const ownerIds = await getTrackedOwnerIds();
  await pullModifiedWithResume("companies", [], COMPANY_DELTA_PROPERTIES, sinceMs, ownerIds, (r) => {
    out.push({
      id: r.id, name: r.properties.name?.trim() || `Company ${r.id}`,
      gdStage: r.properties.lifecycle_stage_gd_level?.trim() || null,
      lifecycleStage: r.properties.lifecyclestage?.trim() || null,
      gdId: r.properties.gd_id?.trim() || null,
      isGroup: r.properties.is_this_is_a_part_of_group_dealership_ === "true",
      groupName: r.properties.dealership_group_name?.trim() || null,
      segment: r.properties.market_segment?.trim() || null,
      dealershipType: r.properties.type_of_dealership?.trim() || null,
      lastActivityMs: toMs(r.properties.notes_last_updated ?? null) || null,
      rooftopLastActivityMs: toMs(r.properties.rooftop_last_activity ?? null) || null,
      ownerId: r.properties.hubspot_owner_id ?? "",
      lastModifiedMs: toMs(r.properties.hs_lastmodifieddate ?? null) || 0,
    });
  });
  return out;
}

/** A deal after pull, before association resolution (company/contacts resolved in associate.ts). */
export interface RawDeal {
  id: string;
  pipeline: string | null;
  dealstage: string | null;
  dealOwnerId: string | null;
  sdrOwnerId: string | null;
  amount: number | null;
  createdMs: number | null; // createdate — windows the funnel (90d default)
  demoScheduledForMs: number | null;
  expectedCloseMs: number | null; // expected_contract_closure_date — the AE's commitment date
  discoveryDoneMs: number | null;
  demoDoneMs: number | null;
  stageEvents: DealStageEvent[]; // per-stage entered/exited (hs_v2 calculated properties)
  lastModifiedMs: number;
}

// Stage-date (hs_v2) properties → the sdr_deal_stage_events ledger; see lib/sync/stage-events.ts.
const DEAL_DELTA_PROPERTIES = [
  "pipeline", "dealstage", "hubspot_owner_id", "sdr_owner", "amount", "createdate",
  "demo_scheduled_for_date", "expected_contract_closure_date",
  "discovery_call_done_stage_date", "demo_done_stage_date",
  "hs_lastmodifieddate",
  ...STAGE_DATE_PROPERTIES,
];

const amountOf = (v: string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Auto-Pipeline deals modified since `sinceMs`, where a tracked rep is the AE (`hubspot_owner_id`)
 * OR the SDR (`sdr_owner`). HubSpot AND-s filters within a group, so we run two owner-scoped passes
 * and union by id. `maxWindows` lifts the resume cap for backfill (drain everything); the default
 * keeps the delta bounded per run. Associations are resolved separately (resolveDealAssociations).
 */
export async function pullChangedDeals(sinceMs: number, maxWindows?: number, ownerIdsOverride?: string[]): Promise<RawDeal[]> {
  const ownerIds = ownerIdsOverride ?? await getTrackedOwnerIds();
  if (ownerIds.length === 0) return [];
  const seen = new Map<string, HsRecord>();
  const collect = (r: HsRecord) => { if (!seen.has(r.id)) seen.set(r.id, r); };
  const pipelineFilter = [{ propertyName: "pipeline", operator: "EQ", value: AUTO_PIPELINE_ID }];
  await pullModifiedWithResume("deals", pipelineFilter, DEAL_DELTA_PROPERTIES, sinceMs, ownerIds, collect, "hubspot_owner_id", maxWindows);
  await pullModifiedWithResume("deals", pipelineFilter, DEAL_DELTA_PROPERTIES, sinceMs, ownerIds, collect, "sdr_owner", maxWindows);
  return [...seen.values()].map((r) => ({
    id: r.id,
    pipeline: r.properties.pipeline ?? null,
    dealstage: r.properties.dealstage ?? null,
    dealOwnerId: r.properties.hubspot_owner_id ?? null,
    sdrOwnerId: r.properties.sdr_owner ?? null,
    amount: amountOf(r.properties.amount),
    createdMs: toMs(r.properties.createdate ?? null) || null,
    demoScheduledForMs: toMs(r.properties.demo_scheduled_for_date ?? null) || null,
    expectedCloseMs: toMs(r.properties.expected_contract_closure_date ?? null) || null,
    discoveryDoneMs: toMs(r.properties.discovery_call_done_stage_date ?? null) || null,
    demoDoneMs: toMs(r.properties.demo_done_stage_date ?? null) || null,
    stageEvents: stageEventsOf(r.properties),
    lastModifiedMs: toMs(r.properties.hs_lastmodifieddate ?? null) || 0,
  }));
}

export interface HsOwnerWithTeams {
  id: string; email: string | null; firstName: string; lastName: string; archived: boolean;
  teams?: { id: string; name: string; primary?: boolean }[];
}

/** All owners (+team memberships) — 1-2 GET pages. */
export async function pullOwnersTeams(): Promise<HsOwnerWithTeams[]> {
  const out: HsOwnerWithTeams[] = [];
  let after: string | undefined;
  do {
    const path = `/crm/v3/owners?limit=100${after ? `&after=${after}` : ""}`;
    const res = await hubspotGet<{ results: HsOwnerWithTeams[]; paging?: { next?: { after?: string } } }>(path);
    out.push(...res.results);
    after = res.paging?.next?.after;
    await delay(RATE_LIMIT_DELAY_MS);
  } while (after);
  return out;
}
