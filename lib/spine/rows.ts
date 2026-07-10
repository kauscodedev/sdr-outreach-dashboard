/** Pure row↔domain mappers + watermark math. No I/O — unit-tested. */
import { Activity, Deal } from "../sync/types";
import { OwnedCompany } from "../sync/pull";
import { ActivityRow, CompanyRow, ContactRow, DealRow } from "./types";
import { ContactMeta } from "../sync/associate";
import { stageKey, isWon, isLost } from "../../config/deal-stages";

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function activityToRow(a: Activity, lastModifiedMs: number | null): ActivityRow {
  return {
    hs_id: a.id, type: a.type, owner_id: a.ownerId, ts_ms: a.timestampMs,
    disposition: a.disposition, email_status: a.emailStatus,
    email_opened: a.emailOpened, email_replied: a.emailReplied, email_clicked: a.emailClicked,
    contact_ids: a.contactIds, company_ids: a.companyIds, hs_lastmodified_ms: lastModifiedMs,
  };
}

export function rowToActivity(r: ActivityRow): Activity {
  return {
    id: r.hs_id, type: r.type, ownerId: r.owner_id, timestampMs: Number(r.ts_ms),
    disposition: r.disposition, emailStatus: r.email_status,
    emailOpened: !!r.email_opened, emailReplied: !!r.email_replied, emailClicked: !!r.email_clicked,
    contactIds: arr(r.contact_ids), companyIds: arr(r.company_ids),
  };
}

export function rowToOwnedCompany(r: CompanyRow): OwnedCompany {
  return {
    id: r.hs_id, name: r.name?.trim() || `Company ${r.hs_id}`, gdStage: r.gd_stage,
    lifecycleStage: r.lifecycle_stage ?? null,
    gdId: r.gd_id, isGroup: !!r.is_group, groupName: r.group_name,
    segment: r.segment, dealershipType: r.dealership_type,
    lastActivityMs: r.last_activity_ms == null ? null : Number(r.last_activity_ms),
    rooftopLastActivityMs: r.rooftop_last_activity_ms == null ? null : Number(r.rooftop_last_activity_ms),
  };
}

export function rowToContactMeta(r: ContactRow): ContactMeta {
  return { name: r.name?.trim() || `Contact ${r.hs_id}`, title: r.title, dm: !!r.dm };
}

export function dealToRow(d: Deal, lastModifiedMs: number | null): DealRow {
  // stage_key / won / lost are DERIVED from the raw (pipeline, dealstage) so the config mapping
  // is the single source of truth — never trust a caller-supplied canonical value.
  const key = stageKey(d.pipeline, d.dealstage);
  return {
    hs_id: d.id, pipeline: d.pipeline, dealstage: d.dealstage, stage_key: key,
    deal_owner_id: d.dealOwnerId, sdr_owner_id: d.sdrOwnerId, company_id: d.companyId,
    contact_ids: d.contactIds, amount: d.amount,
    demo_scheduled_for_ms: d.demoScheduledForMs, discovery_done_ms: d.discoveryDoneMs,
    demo_done_ms: d.demoDoneMs, is_closed_won: isWon(key), is_closed_lost: isLost(key),
    hs_lastmodified_ms: lastModifiedMs,
  };
}

export function rowToDeal(r: DealRow): Deal {
  return {
    id: r.hs_id, pipeline: r.pipeline, dealstage: r.dealstage,
    stageKey: stageKey(r.pipeline, r.dealstage), // recompute — the mapping stays the source of truth
    dealOwnerId: r.deal_owner_id, sdrOwnerId: r.sdr_owner_id, companyId: r.company_id,
    contactIds: arr(r.contact_ids), amount: r.amount == null ? null : Number(r.amount),
    demoScheduledForMs: r.demo_scheduled_for_ms == null ? null : Number(r.demo_scheduled_for_ms),
    discoveryDoneMs: r.discovery_done_ms == null ? null : Number(r.discovery_done_ms),
    demoDoneMs: r.demo_done_ms == null ? null : Number(r.demo_done_ms),
  };
}

/** Monotonic watermark advance over the batch actually processed. */
export function nextWatermark(prev: number, items: { lastModifiedMs?: number | null }[]): number {
  let max = prev;
  for (const i of items) if (i.lastModifiedMs != null && i.lastModifiedMs > max) max = i.lastModifiedMs;
  return max;
}
