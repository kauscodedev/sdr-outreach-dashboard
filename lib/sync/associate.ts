/**
 * Resolve engagement -> contact -> company associations using HubSpot v4 batch
 * reads (up to 1000 ids/request) instead of one GET per activity. For a month of
 * activity this is ~tens of requests rather than tens of thousands.
 *
 * Company attribution per activity:
 *   union direct engagement->company associations with the primary company of
 *   each associated contact. Direct associations matter for GD coverage: a
 *   contact's primary company can differ from the specific rooftop where the
 *   call/email was logged.
 */

import { hubspotPost, RATE_LIMIT_DELAY_MS, delay } from "../hubspot/client";
import { Activity } from "./types";
import { RawActivity } from "./pull";

const ASSOC_BATCH = 1000; // v4 batch read input limit
const OBJ_BATCH = 100; // v3 objects batch read input limit

interface V4Target {
  toObjectId?: number | string;
  associationTypes?: { category?: string; typeId?: number; label?: string | null }[];
}
interface V4Result {
  from: { id: string };
  to?: V4Target[];
}
interface V4Response {
  results?: V4Result[];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface AssocTarget {
  toId: string;
  primary: boolean;
}

/** Generic v4 batch read: fromId -> [{toId, primary}]. */
async function batchReadAssociations(
  fromType: string,
  toType: string,
  fromIds: string[],
): Promise<Map<string, AssocTarget[]>> {
  const map = new Map<string, AssocTarget[]>();
  if (fromIds.length === 0) return map;

  for (const ids of chunk(fromIds, ASSOC_BATCH)) {
    const body = { inputs: ids.map((id) => ({ id })) };
    const res = await hubspotPost<V4Response>(
      `/crm/v4/associations/${fromType}/${toType}/batch/read`,
      body,
    );
    for (const r of res.results ?? []) {
      const targets: AssocTarget[] = (r.to ?? [])
        .map((t) => {
          const toId = t.toObjectId != null ? String(t.toObjectId) : "";
          // Contact's primary company association is HUBSPOT_DEFINED typeId 1,
          // or carries a "Primary" label.
          const primary = (t.associationTypes ?? []).some(
            (a) =>
              (a.typeId === 1 && (a.category ?? "").toUpperCase() === "HUBSPOT_DEFINED") ||
              /primary/i.test(a.label ?? ""),
          );
          return { toId, primary };
        })
        .filter((t) => t.toId);
      if (targets.length) map.set(r.from.id, targets);
    }
    await delay(RATE_LIMIT_DELAY_MS);
  }
  return map;
}

interface ObjResp {
  results?: { id: string; properties?: Record<string, string | null> }[];
}

/** Resolve names + GD-level stage for company ids via v3 objects batch read. */
async function resolveCompanies(companyIds: string[]): Promise<{ names: Record<string, string>; gdStage: Record<string, string | null> }> {
  const names: Record<string, string> = {};
  const gdStage: Record<string, string | null> = {};
  if (companyIds.length === 0) return { names, gdStage };
  for (const ids of chunk(companyIds, OBJ_BATCH)) {
    const body = { properties: ["name", "lifecycle_stage_gd_level"], inputs: ids.map((id) => ({ id })) };
    const res = await hubspotPost<ObjResp>(`/crm/v3/objects/companies/batch/read`, body);
    for (const r of res.results ?? []) {
      names[r.id] = r.properties?.name?.trim() || `Company ${r.id}`;
      gdStage[r.id] = r.properties?.lifecycle_stage_gd_level ?? null;
    }
    await delay(RATE_LIMIT_DELAY_MS);
  }
  return { names, gdStage };
}

export interface ContactMeta {
  name: string;
  title: string | null;
  dm: boolean; // decision-maker (by seniority / job title)
}

// Decision-maker job titles (auto/dealership-aware) + senior seniority signals.
const DM_TITLE = /\b(owner|co-?founder|founder|ceo|coo|cfo|cto|cmo|cio|chief|president|vice\s?president|vp|svp|evp|director|head|principal|partner|gm|general\s?manager|managing|proprietor|dealer principal|managing director|md)\b/i;
const DM_SENIORITY = /exec|owner|chief|director|c.?suite|principal|founder|president|vice/i;

function isDecisionMaker(title: string, seniority: string): boolean {
  return (!!title && DM_TITLE.test(title)) || (!!seniority && DM_SENIORITY.test(seniority));
}

/** Resolve display names + job title + decision-maker flag for contacts. */
async function resolveContactMeta(contactIds: string[]): Promise<Record<string, ContactMeta>> {
  const meta: Record<string, ContactMeta> = {};
  if (contactIds.length === 0) return meta;
  for (const ids of chunk(contactIds, OBJ_BATCH)) {
    const body = { properties: ["firstname", "lastname", "email", "jobtitle", "seniority"], inputs: ids.map((id) => ({ id })) };
    const res = await hubspotPost<ObjResp>(`/crm/v3/objects/contacts/batch/read`, body);
    for (const r of res.results ?? []) {
      const p = r.properties ?? {};
      const full = [p.firstname, p.lastname].filter(Boolean).join(" ").trim();
      const title = (p.jobtitle ?? "").trim();
      meta[r.id] = {
        name: full || p.email?.trim() || `Contact ${r.id}`,
        title: title || null,
        dm: isDecisionMaker(title, (p.seniority ?? "").trim()),
      };
    }
    await delay(RATE_LIMIT_DELAY_MS);
  }
  return meta;
}

function pickPrimaryCompany(targets: AssocTarget[] | undefined): string | null {
  if (!targets || targets.length === 0) return null;
  const primary = targets.find((t) => t.primary);
  return (primary ?? targets[0]).toId; // deterministic first-company fallback
}

export function companyIdsForActivity(
  contactIds: string[],
  contactCompany: Map<string, string>,
  directCompanyIds: string[] | undefined,
): string[] {
  const out = new Set<string>();
  for (const c of contactIds) {
    const co = contactCompany.get(c);
    if (co) out.add(co);
  }
  for (const co of directCompanyIds ?? []) out.add(co);
  return [...out];
}

export interface ResolveResult {
  activities: Activity[];
  companyNames: Record<string, string>;
  companyGdStage: Record<string, string | null>;
  contactMeta: Record<string, ContactMeta>;
}

export async function resolveAssociations(raw: RawActivity[]): Promise<ResolveResult> {
  const callIds = raw.filter((a) => a.type === "call").map((a) => a.id);
  const emailIds = raw.filter((a) => a.type === "email").map((a) => a.id);

  console.log(`Resolving associations: ${callIds.length} calls, ${emailIds.length} emails…`);
  const callContacts = await batchReadAssociations("calls", "contacts", callIds);
  const emailContacts = await batchReadAssociations("emails", "contacts", emailIds);

  // activityId -> contactIds (all associated contacts count toward "tapped")
  const activityContacts = new Map<string, string[]>();
  const allContactIds = new Set<string>();
  for (const [id, targets] of [...callContacts, ...emailContacts]) {
    const contactIds = targets.map((t) => t.toId);
    activityContacts.set(id, contactIds);
    contactIds.forEach((c) => allContactIds.add(c));
  }

  // contactId -> primary companyId
  console.log(`Resolving primary companies for ${allContactIds.size} contacts…`);
  const contactCompanyTargets = await batchReadAssociations(
    "contacts",
    "companies",
    [...allContactIds],
  );
  const contactCompany = new Map<string, string>();
  for (const [contactId, targets] of contactCompanyTargets) {
    const co = pickPrimaryCompany(targets);
    if (co) contactCompany.set(contactId, co);
  }

  // Direct company associations are not just a fallback. In HubSpot, a logged
  // engagement can point at a specific rooftop even when the associated contact's
  // primary company points somewhere else in the dealer group.
  console.log(
    `Resolving direct company associations for ${callIds.length} calls + ${emailIds.length} emails…`,
  );
  const callCompanies = await batchReadAssociations("calls", "companies", callIds);
  const emailCompanies = await batchReadAssociations("emails", "companies", emailIds);
  const directCompany = new Map<string, string[]>();
  for (const [id, targets] of [...callCompanies, ...emailCompanies]) {
    directCompany.set(id, targets.map((t) => t.toId));
  }

  // Build normalized activities.
  const usedCompanyIds = new Set<string>();
  const activities: Activity[] = raw.map((a) => {
    const contactIds = activityContacts.get(a.id) ?? [];
    const companyIds = companyIdsForActivity(contactIds, contactCompany, directCompany.get(a.id));
    companyIds.forEach((c) => usedCompanyIds.add(c));
    return {
      id: a.id,
      type: a.type,
      ownerId: a.ownerId,
      timestampMs: a.timestampMs,
      disposition: a.disposition,
      emailStatus: a.emailStatus,
      emailOpened: a.emailOpened,
      emailReplied: a.emailReplied,
      emailClicked: a.emailClicked,
      contactIds,
      companyIds,
    };
  });

  console.log(`Resolving ${usedCompanyIds.size} company names + GD-level stage…`);
  const { names: companyNames, gdStage: companyGdStage } = await resolveCompanies([...usedCompanyIds]);

  console.log(`Resolving ${allContactIds.size} contact names + titles…`);
  const contactMeta = await resolveContactMeta([...allContactIds]);

  return { activities, companyNames, companyGdStage, contactMeta };
}
