/** Pure row↔domain mappers + watermark math. No I/O — unit-tested. */
import { Activity } from "../sync/types";
import { OwnedCompany } from "../sync/pull";
import { ActivityRow, CompanyRow, ContactRow } from "./types";
import { ContactMeta } from "../sync/associate";

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
    gdId: r.gd_id, isGroup: !!r.is_group, groupName: r.group_name,
    segment: r.segment, dealershipType: r.dealership_type,
  };
}

export function rowToContactMeta(r: ContactRow): ContactMeta {
  return { name: r.name?.trim() || `Contact ${r.hs_id}`, title: r.title, dm: !!r.dm };
}

/** Monotonic watermark advance over the batch actually processed. */
export function nextWatermark(prev: number, items: { lastModifiedMs?: number | null }[]): number {
  let max = prev;
  for (const i of items) if (i.lastModifiedMs != null && i.lastModifiedMs > max) max = i.lastModifiedMs;
  return max;
}
