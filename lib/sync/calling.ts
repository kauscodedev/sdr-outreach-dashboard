/**
 * Calling drill-down (pure): fold one rep's call activities for a period window into the
 * manager view of WHO was called, WHERE (rooftops), and WHAT happened (outcomes) — the layer
 * under the Overview aggregates. Business rules match lib/sync/aggregate.ts: "connected" is the
 * CONNECTED_DISPOSITIONS allowlist, connect-rate excludes null-disposition calls from the
 * denominator, and a multi-company call credits every associated rooftop. Served lazily by
 * /api/rep/[ownerId]/calling (spine read at request time — never stored in the snapshot).
 */
import { isConnected, isMeeting, dispositionLabel } from "../../config/dispositions";
import { ContactMeta } from "./associate";
import { Activity } from "./types";

const LOG_CAP = 800; // newest-first call-log rows per response; summary keeps the true total

export interface CallingSummary {
  calls: number;
  connected_calls: number;
  no_disposition: number;
  connect_rate: number; // connected / (connected + not_connected) — null-disposition excluded
  unique_contacts: number;
  contacts_connected: number; // unique contacts with ≥1 connected call
  unique_rooftops: number;
  rooftops_connected: number; // unique companies with ≥1 connected call
  meetings: number; // meeting-scheduled outcomes
  unattributed_calls: number; // calls with no company association
}

export interface CallingOutcome {
  label: string; // disposition label ("No disposition" for null)
  count: number;
  contacts: number; // unique contacts that got this outcome
  connected: boolean;
}

/** One unique contact called this period (also nested per rooftop, company fields redundant there). */
export interface CalledContactRow {
  id: string;
  name: string;
  title?: string;
  dm?: boolean;
  company_id: string | null; // first company of the contact's most recent call
  company_name: string | null;
  calls: number;
  connected: number;
  outcomes: Record<string, number>; // label -> count
  last_ms: number;
  last_outcome: string;
}

export interface CalledRooftopRow {
  id: string;
  name: string;
  calls: number;
  connected: number;
  meetings: number;
  outcomes: Record<string, number>;
  last_ms: number;
  contacts: CalledContactRow[]; // who within the rooftop, dials desc
}

export interface CallLogRow {
  id: string;
  ts_ms: number;
  contact_id: string | null;
  contact_name: string | null;
  company_id: string | null;
  company_name: string | null;
  outcome: string;
  connected: boolean;
}

export interface CallingDetail {
  summary: CallingSummary;
  outcomes: CallingOutcome[]; // count desc
  contacts: CalledContactRow[]; // dials desc
  rooftops: CalledRooftopRow[]; // dials desc
  log: CallLogRow[]; // newest first, capped
  log_truncated: boolean;
}

interface EntityAcc {
  calls: number;
  connected: number;
  meetings: number;
  outcomes: Map<string, number>;
  lastMs: number;
  lastOutcome: string;
  lastCompanyId: string | null; // contacts only: company of the most recent call
  contactIds: Set<string>; // rooftops only: who was called
}

const newEntityAcc = (): EntityAcc => ({
  calls: 0, connected: 0, meetings: 0, outcomes: new Map(),
  lastMs: 0, lastOutcome: "", lastCompanyId: null, contactIds: new Set(),
});

function record(acc: EntityAcc, a: Activity, label: string, connected: boolean): void {
  acc.calls++;
  if (connected) acc.connected++;
  if (isMeeting(a.disposition)) acc.meetings++;
  acc.outcomes.set(label, (acc.outcomes.get(label) ?? 0) + 1);
  if (a.timestampMs >= acc.lastMs) {
    acc.lastMs = a.timestampMs;
    acc.lastOutcome = label;
    acc.lastCompanyId = a.companyIds[0] ?? acc.lastCompanyId;
  }
  for (const cid of a.contactIds) acc.contactIds.add(cid);
}

export function buildCallingDetail(
  activities: Activity[],
  contactMeta: Record<string, ContactMeta>,
  companyNames: Record<string, string>,
  opts: { logCap?: number } = {},
): CallingDetail {
  const logCap = opts.logCap ?? LOG_CAP;

  let calls = 0, connectedCalls = 0, noDisposition = 0, notConnected = 0, meetings = 0, unattributed = 0;
  const byOutcome = new Map<string, { count: number; contacts: Set<string>; connected: boolean }>();
  const byContact = new Map<string, EntityAcc>();
  const byCompany = new Map<string, EntityAcc>();
  const log: CallLogRow[] = [];

  for (const a of activities) {
    if (a.type !== "call") continue; // defensive — the route already filters
    calls++;
    const connected = isConnected(a.disposition);
    const label = dispositionLabel(a.disposition);
    if (connected) connectedCalls++;
    else if (!a.disposition) noDisposition++;
    else notConnected++;
    if (isMeeting(a.disposition)) meetings++;
    if (a.companyIds.length === 0) unattributed++;

    const o = byOutcome.get(label) ?? { count: 0, contacts: new Set<string>(), connected };
    o.count++;
    for (const cid of a.contactIds) o.contacts.add(cid);
    byOutcome.set(label, o);

    for (const cid of a.contactIds) {
      const acc = byContact.get(cid) ?? newEntityAcc();
      record(acc, a, label, connected);
      byContact.set(cid, acc);
    }
    for (const co of a.companyIds) {
      const acc = byCompany.get(co) ?? newEntityAcc();
      record(acc, a, label, connected);
      byCompany.set(co, acc);
    }

    log.push({
      id: a.id,
      ts_ms: a.timestampMs,
      contact_id: a.contactIds[0] ?? null,
      contact_name: a.contactIds[0] ? (contactMeta[a.contactIds[0]]?.name ?? `Contact ${a.contactIds[0]}`) : null,
      company_id: a.companyIds[0] ?? null,
      company_name: a.companyIds[0] ? (companyNames[a.companyIds[0]] ?? `Company ${a.companyIds[0]}`) : null,
      outcome: label,
      connected,
    });
  }

  const toContactRow = (id: string, acc: EntityAcc): CalledContactRow => {
    const meta = contactMeta[id];
    return {
      id,
      name: meta?.name ?? `Contact ${id}`,
      title: meta?.title ?? undefined,
      dm: meta?.dm,
      company_id: acc.lastCompanyId,
      company_name: acc.lastCompanyId ? (companyNames[acc.lastCompanyId] ?? `Company ${acc.lastCompanyId}`) : null,
      calls: acc.calls,
      connected: acc.connected,
      outcomes: Object.fromEntries(acc.outcomes),
      last_ms: acc.lastMs,
      last_outcome: acc.lastOutcome,
    };
  };

  const contacts = [...byContact.entries()]
    .map(([id, acc]) => toContactRow(id, acc))
    .sort((a, b) => b.calls - a.calls || b.last_ms - a.last_ms);

  const rooftops: CalledRooftopRow[] = [...byCompany.entries()]
    .map(([id, acc]) => ({
      id,
      name: companyNames[id] ?? `Company ${id}`,
      calls: acc.calls,
      connected: acc.connected,
      meetings: acc.meetings,
      outcomes: Object.fromEntries(acc.outcomes),
      last_ms: acc.lastMs,
      contacts: [...acc.contactIds]
        .filter((cid) => byContact.has(cid))
        .map((cid) => toContactRow(cid, byContact.get(cid)!))
        .sort((a, b) => b.calls - a.calls || b.last_ms - a.last_ms),
    }))
    .sort((a, b) => b.calls - a.calls || b.last_ms - a.last_ms);

  const outcomes: CallingOutcome[] = [...byOutcome.entries()]
    .map(([label, o]) => ({ label, count: o.count, contacts: o.contacts.size, connected: o.connected }))
    .sort((a, b) => b.count - a.count);

  log.sort((a, b) => b.ts_ms - a.ts_ms);

  let contactsConnected = 0;
  for (const acc of byContact.values()) if (acc.connected > 0) contactsConnected++;
  let rooftopsConnected = 0;
  for (const acc of byCompany.values()) if (acc.connected > 0) rooftopsConnected++;

  const denom = connectedCalls + notConnected;
  return {
    summary: {
      calls,
      connected_calls: connectedCalls,
      no_disposition: noDisposition,
      connect_rate: denom ? connectedCalls / denom : 0,
      unique_contacts: byContact.size,
      contacts_connected: contactsConnected,
      unique_rooftops: byCompany.size,
      rooftops_connected: rooftopsConnected,
      meetings,
      unattributed_calls: unattributed,
    },
    outcomes,
    contacts,
    rooftops,
    log: log.slice(0, logCap),
    log_truncated: log.length > logCap,
  };
}
