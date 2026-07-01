/**
 * Aggregate resolved activities into per-rep, per-period metrics — a sales-leader
 * view of both QUANTITY and QUALITY of outbound engagement:
 *   - reach split by activity (contacts/companies via call / email / both)
 *   - email engagement (opens / replies / clicks)
 *   - decision-maker reach (by job title / seniority)
 *   - coverage of the rep's owned book, segmented by lifecycle ("gd level")
 *   - account temperature (hot/warm/cold) WITH a reason, from real signals
 *   - persistence (multi-touch), a composite quality score, and rule-based insights
 */

import { REPS, REP_OWNER_IDS } from "../../config/reps";
import { isConnected, isHighIntent, isMeeting, dispositionLabel } from "../../config/dispositions";
import { IstContext, periodsForActivity, istDateStr, IST_OFFSET_MS } from "./buckets";
import { OwnedCompany } from "./pull";
import { ContactMeta } from "./associate";
import {
  Activity,
  AccountTemp,
  Coverage,
  DailyPoint,
  Insight,
  PERIOD_KEYS,
  NARROW_PERIODS,
  PeriodKey,
  PeriodMetrics,
  QualityScore,
  ReachByChannel,
  RepData,
  Snapshot,
  StageCoverage,
  StageGroup,
  Temperature,
} from "./types";

const DAY_MS = 86_400_000;
const COVERAGE_SAMPLE_PERIODS = new Set<PeriodKey>(["this_week", "this_month"]);
const UNTAPPED_SAMPLE_CAP = 200;

/** Map a raw lifecyclestage value to a coarse pipeline group ("gd level"). */
function stageGroup(lifecycle: string | null | undefined): StageGroup {
  switch (lifecycle) {
    case "customer":
    case "evangelist":
      return "Converted";
    case "salesqualifiedlead":
    case "opportunity":
      return "In-pipeline";
    case "lead":
    case "marketingqualifiedlead":
    case "subscriber":
    case "1816032986": // Prospect
    case "1817479910": // Assigned
      return "Lead/MQL";
    default:
      return "Other";
  }
}

interface CompanyStat {
  contacts: Set<string>;
  calls: number;
  emails: number;
  connected: number;
  meeting: boolean;
  highIntent: boolean;
  opened: number;
  replied: number;
}

interface Acc {
  contactTouch: Map<string, { call: number; email: number }>;
  companyStat: Map<string, CompanyStat>;
  callsTotal: number;
  callsConnected: number;
  callsNotConnected: number;
  callsNull: number;
  meetingsBooked: number;
  byDisposition: Map<string, number>;
  emailsSent: number;
  emailsBounced: number;
  emailsOpened: number;
  emailsReplied: number;
  emailsClicked: number;
  unattributed: number;
}

function newAcc(): Acc {
  return {
    contactTouch: new Map(),
    companyStat: new Map(),
    callsTotal: 0, callsConnected: 0, callsNotConnected: 0, callsNull: 0,
    meetingsBooked: 0, byDisposition: new Map(),
    emailsSent: 0, emailsBounced: 0, emailsOpened: 0, emailsReplied: 0, emailsClicked: 0,
    unattributed: 0,
  };
}

function applyActivity(acc: Acc, a: Activity): void {
  if (a.type === "call") {
    acc.callsTotal++;
    if (!a.disposition) acc.callsNull++;
    else if (isConnected(a.disposition)) acc.callsConnected++;
    else acc.callsNotConnected++;
    if (isMeeting(a.disposition)) acc.meetingsBooked++;
    const lbl = dispositionLabel(a.disposition);
    acc.byDisposition.set(lbl, (acc.byDisposition.get(lbl) ?? 0) + 1);
  } else {
    acc.emailsSent++;
    if ((a.emailStatus ?? "").toUpperCase() === "BOUNCED") acc.emailsBounced++;
    if (a.emailOpened) acc.emailsOpened++;
    if (a.emailReplied) acc.emailsReplied++;
    if (a.emailClicked) acc.emailsClicked++;
  }

  for (const c of a.contactIds) {
    const t = acc.contactTouch.get(c) ?? { call: 0, email: 0 };
    if (a.type === "call") t.call++;
    else t.email++;
    acc.contactTouch.set(c, t);
  }

  for (const co of a.companyIds) {
    const s = acc.companyStat.get(co) ?? { contacts: new Set<string>(), calls: 0, emails: 0, connected: 0, meeting: false, highIntent: false, opened: 0, replied: 0 };
    a.contactIds.forEach((c) => s.contacts.add(c));
    if (a.type === "call") {
      s.calls++;
      if (a.disposition && isConnected(a.disposition)) s.connected++;
      if (isMeeting(a.disposition)) s.meeting = true;
      if (isHighIntent(a.disposition)) s.highIntent = true;
    } else {
      s.emails++;
      if (a.emailOpened) s.opened++;
      if (a.emailReplied) s.replied++;
    }
    acc.companyStat.set(co, s);
  }

  if (a.contactIds.length === 0 && a.companyIds.length === 0) acc.unattributed++;
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function temperatureOf(s: CompanyStat): Temperature {
  if (s.meeting || s.highIntent || s.replied > 0) return "hot";
  if (s.connected > 0 || s.opened > 0 || s.calls + s.emails >= 3) return "warm";
  return "cold";
}

function temperatureReason(s: CompanyStat): string {
  const touches = s.calls + s.emails;
  if (s.meeting) return "Meeting booked";
  if (s.highIntent) return "High-intent callback";
  if (s.replied > 0) return `Replied to email`;
  if (s.connected > 0) return `Connected ${s.connected}×${s.opened > 0 ? `, opened ${s.opened}` : ""}`;
  if (s.opened > 0) return `Opened email${s.opened > 1 ? ` ${s.opened}×` : ""}, no call connect`;
  if (touches >= 3) return `${touches} touches, no engagement`;
  if (s.calls > 0) return `${s.calls} call${s.calls > 1 ? "s" : ""}, no connect`;
  if (s.emails > 0) return `Emailed, no open/reply`;
  return "Touched";
}

function reachOf(entries: { call: boolean; email: boolean }[]): ReachByChannel {
  let callOnly = 0, emailOnly = 0, both = 0;
  for (const e of entries) {
    if (e.call && e.email) both++;
    else if (e.call) callOnly++;
    else if (e.email) emailOnly++;
  }
  return { total: callOnly + emailOnly + both, call_only: callOnly, email_only: emailOnly, both, via_call: callOnly + both, via_email: emailOnly + both };
}

function computeQuality(args: {
  connectRate: number; meetings: number; replyRate: number; openRate: number;
  depth: number; persistenceShare: number; calls: number; emails: number; bounceRate: number; hasActivity: boolean;
}): QualityScore {
  if (!args.hasActivity) return { score: 0, grade: "—", sub: { conversations: 0, depth: 0, persistence: 0, channel: 0, deliverability: 0 } };
  const conversations = 100 * (0.5 * clamp01(args.connectRate / 0.2) + 0.3 * clamp01(args.meetings / 3) + 0.2 * clamp01(args.replyRate / 0.1));
  const depth = 100 * clamp01((args.depth - 1) / 2);
  const persistence = 100 * clamp01(args.persistenceShare);
  const totalAct = args.calls + args.emails;
  const callShare = totalAct ? args.calls / totalAct : 0;
  const balance = 1 - Math.abs(callShare - 0.5) * 2;
  const channel = 100 * (0.4 + 0.6 * clamp01(balance));
  const deliverability = args.emails === 0 ? 100 : 100 * (0.5 * clamp01(1 - args.bounceRate) + 0.5 * clamp01(args.openRate / 0.4));

  const score = Math.round(0.35 * conversations + 0.2 * depth + 0.2 * persistence + 0.15 * channel + 0.1 * deliverability);
  const grade = score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : score >= 35 ? "D" : "F";
  return { score, grade, sub: { conversations: Math.round(conversations), depth: Math.round(depth), persistence: Math.round(persistence), channel: Math.round(channel), deliverability: Math.round(deliverability) } };
}

function buildInsights(m: {
  hasActivity: boolean; coverage: Coverage; meetings: number; hot: number;
  calls: number; emails: number; connectRate: number; connectDenom: number;
  companiesTapped: number; depth: number; persistenceShare: number;
  emailsSent: number; bounceRate: number; replyRate: number;
  dmContacts: number; titledContacts: number;
}): Insight[] {
  if (!m.hasActivity) return [{ level: "warn", text: "💤 No outbound activity this period" }];
  const out: Insight[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  if (m.coverage.owned_total > 0) {
    if (m.coverage.pct < 0.5) out.push({ level: "warn", text: `⚠ ${m.coverage.untapped_count} of ${m.coverage.owned_total} owned accounts untapped (${pct(m.coverage.pct)} covered)` });
    else out.push({ level: "good", text: `✓ ${pct(m.coverage.pct)} of owned accounts tapped` });
  }
  const pipe = m.coverage.by_stage["In-pipeline"];
  if (pipe && pipe.owned > 0 && pipe.tapped / pipe.owned < 0.5) out.push({ level: "warn", text: `🎯 Only ${pct(pipe.tapped / pipe.owned)} of in-pipeline accounts tapped` });

  if (m.meetings > 0) out.push({ level: "good", text: `🎯 ${m.meetings} meeting${m.meetings > 1 ? "s" : ""} booked` });
  if (m.hot > 0) out.push({ level: "good", text: `🔥 ${m.hot} hot account${m.hot > 1 ? "s" : ""}` });
  if (m.emailsSent >= 10 && m.replyRate >= 0.05) out.push({ level: "good", text: `📨 ${pct(m.replyRate)} email reply rate` });
  if (m.titledContacts >= 5) {
    const share = m.dmContacts / m.titledContacts;
    if (share < 0.3) out.push({ level: "warn", text: `🙋 Low decision-maker reach (${pct(share)})` });
    else if (share >= 0.5) out.push({ level: "good", text: `🙋 ${pct(share)} decision-makers reached` });
  }
  if (m.emails === 0 && m.calls > 0) out.push({ level: "warn", text: "📞 Call-only — 0 emails (single-channel)" });
  if (m.calls === 0 && m.emails > 0) out.push({ level: "warn", text: "✉ Email-only — 0 calls (single-channel)" });
  if (m.connectDenom >= 20 && m.connectRate < 0.08) out.push({ level: "warn", text: `📉 Low connect rate ${pct(m.connectRate)}` });
  if (m.companiesTapped >= 10 && m.depth < 1.3) out.push({ level: "warn", text: `🪨 Shallow — ${m.depth.toFixed(1)} contacts/account` });
  if (m.companiesTapped >= 10 && m.persistenceShare < 0.2) out.push({ level: "warn", text: `🔁 Only ${pct(m.persistenceShare)} of accounts re-touched` });
  if (m.emailsSent >= 10 && m.bounceRate > 0.1) out.push({ level: "warn", text: `⚠ High email bounce ${pct(m.bounceRate)}` });
  return out;
}

const EMPTY_STAGE = (): Record<StageGroup, StageCoverage> => ({
  Converted: { owned: 0, tapped: 0 }, "In-pipeline": { owned: 0, tapped: 0 }, "Lead/MQL": { owned: 0, tapped: 0 }, Other: { owned: 0, tapped: 0 },
});

function finalize(
  acc: Acc,
  period: PeriodKey,
  companyNames: Record<string, string>,
  companyLifecycle: Record<string, string | null>,
  contactMeta: Record<string, ContactMeta>,
  ownedSet: Set<string>,
  ownedList: OwnedCompany[],
): PeriodMetrics {
  const contacts = reachOf([...acc.contactTouch.values()].map((t) => ({ call: t.call > 0, email: t.email > 0 })));
  const companies = reachOf([...acc.companyStat.values()].map((s) => ({ call: s.calls > 0, email: s.emails > 0 })));

  let multitouchContacts = 0;
  for (const t of acc.contactTouch.values()) if (t.call + t.email >= 2) multitouchContacts++;

  // Decision-maker reach.
  let dmContacts = 0, titledContacts = 0;
  for (const cid of acc.contactTouch.keys()) {
    const meta = contactMeta[cid];
    if (!meta) continue;
    if (meta.title) titledContacts++;
    if (meta.dm) dmContacts++;
  }

  let companiesWithContact = 0, contactsInCompanies = 0, multitouchAccounts = 0;
  const temp: AccountTemp = { hot: 0, warm: 0, cold: 0 };
  for (const s of acc.companyStat.values()) {
    if (s.contacts.size > 0) { companiesWithContact++; contactsInCompanies += s.contacts.size; }
    if (s.calls + s.emails >= 2) multitouchAccounts++;
    temp[temperatureOf(s)]++;
  }
  const companiesTapped = acc.companyStat.size;
  const depth = companiesWithContact ? contactsInCompanies / companiesWithContact : 0;

  const connectDenom = acc.callsConnected + acc.callsNotConnected;
  const connectRate = connectDenom ? acc.callsConnected / connectDenom : 0;
  const bounceRate = acc.emailsSent ? acc.emailsBounced / acc.emailsSent : 0;
  const openRate = acc.emailsSent ? acc.emailsOpened / acc.emailsSent : 0;
  const replyRate = acc.emailsSent ? acc.emailsReplied / acc.emailsSent : 0;
  const clickRate = acc.emailsSent ? acc.emailsClicked / acc.emailsSent : 0;
  const persistenceShare = companiesTapped ? multitouchAccounts / companiesTapped : 0;

  // Coverage of owned book + by lifecycle group.
  const byStage = EMPTY_STAGE();
  let ownedTapped = 0;
  for (const c of ownedList) {
    const g = stageGroup(c.lifecycle);
    byStage[g].owned++;
    if (acc.companyStat.has(c.id)) { byStage[g].tapped++; ownedTapped++; }
  }
  const ownedTotal = ownedList.length;
  const untappedSample =
    COVERAGE_SAMPLE_PERIODS.has(period) && ownedTotal > 0
      ? ownedList.filter((c) => !acc.companyStat.has(c.id)).slice(0, UNTAPPED_SAMPLE_CAP).map((c) => ({ id: c.id, name: c.name, stage: stageGroup(c.lifecycle) }))
      : [];
  const coverage: Coverage = {
    owned_total: ownedTotal,
    owned_tapped: ownedTapped,
    pct: ownedTotal ? round(ownedTapped / ownedTotal, 3) : 0,
    untapped_count: Math.max(0, ownedTotal - ownedTapped),
    untapped_sample: untappedSample,
    by_stage: byStage,
  };

  const hasActivity = acc.callsTotal + acc.emailsSent > 0;
  const quality = computeQuality({ connectRate, meetings: acc.meetingsBooked, replyRate, openRate, depth, persistenceShare, calls: acc.callsTotal, emails: acc.emailsSent, bounceRate, hasActivity });
  const insights = buildInsights({ hasActivity, coverage, meetings: acc.meetingsBooked, hot: temp.hot, calls: acc.callsTotal, emails: acc.emailsSent, connectRate, connectDenom, companiesTapped, depth, persistenceShare, emailsSent: acc.emailsSent, bounceRate, replyRate, dmContacts, titledContacts });

  const metrics: PeriodMetrics = {
    calls: {
      total: acc.callsTotal, connected: acc.callsConnected, not_connected: acc.callsNotConnected, null_disposition: acc.callsNull,
      connect_rate: round(connectRate, 3), by_disposition: Object.fromEntries([...acc.byDisposition.entries()].sort((a, b) => b[1] - a[1])),
    },
    emails: {
      sent: acc.emailsSent, bounced: acc.emailsBounced, bounce_rate: round(bounceRate, 3),
      opened: acc.emailsOpened, replied: acc.emailsReplied, clicked: acc.emailsClicked,
      open_rate: round(openRate, 3), reply_rate: round(replyRate, 3), click_rate: round(clickRate, 3),
    },
    meetings_booked: acc.meetingsBooked,
    contacts,
    companies,
    companies_with_contact: companiesWithContact,
    avg_contacts_per_company: round(depth),
    multitouch_contacts: multitouchContacts,
    multitouch_accounts: multitouchAccounts,
    dm_contacts: dmContacts,
    titled_contacts: titledContacts,
    coverage,
    temp,
    quality,
    insights,
    unattributed_activities: acc.unattributed,
  };

  if (NARROW_PERIODS.includes(period)) {
    metrics.company_breakdown = [...acc.companyStat.entries()]
      .map(([id, s]) => ({
        id,
        name: companyNames[id] ?? `Company ${id}`,
        contacts: s.contacts.size,
        calls: s.calls,
        emails: s.emails,
        temp: temperatureOf(s),
        temp_reason: temperatureReason(s),
        stage: stageGroup(companyLifecycle[id]),
        opened: s.opened,
        replied: s.replied,
        owned: ownedSet.has(id),
        contacts_list: [...s.contacts].map((cid) => {
          const meta = contactMeta[cid];
          return { id: cid, name: meta?.name ?? `Contact ${cid}`, title: meta?.title ?? undefined, dm: meta?.dm };
        }),
      }))
      .sort((a, b) => b.calls + b.emails - (a.calls + a.emails));
  }

  return metrics;
}

export function aggregate(
  activities: Activity[],
  companyNames: Record<string, string>,
  companyLifecycle: Record<string, string | null>,
  contactMeta: Record<string, ContactMeta>,
  ownedCompanies: Record<string, OwnedCompany[]>,
  ctx: IstContext,
  generatedAtMs: number,
  sources: { calls: boolean; emails: boolean },
): Snapshot {
  const accs = new Map<string, Map<PeriodKey, Acc>>();
  const dailyAcc = new Map<string, Map<string, { calls: number; connected: number; emails: number }>>();
  for (const ownerId of REP_OWNER_IDS) {
    const byPeriod = new Map<PeriodKey, Acc>();
    for (const p of PERIOD_KEYS) byPeriod.set(p, newAcc());
    accs.set(ownerId, byPeriod);
    dailyAcc.set(ownerId, new Map());
  }

  let totalCalls = 0, totalEmails = 0;
  for (const a of activities) {
    if (a.type === "call") totalCalls++;
    else totalEmails++;
    const byPeriod = accs.get(a.ownerId);
    if (!byPeriod) continue;
    for (const period of periodsForActivity(a.timestampMs, ctx)) applyActivity(byPeriod.get(period)!, a);

    const day = istDateStr(a.timestampMs);
    const dmap = dailyAcc.get(a.ownerId)!;
    const d = dmap.get(day) ?? { calls: 0, connected: 0, emails: 0 };
    if (a.type === "call") { d.calls++; if (a.disposition && isConnected(a.disposition)) d.connected++; }
    else d.emails++;
    dmap.set(day, d);
  }

  const startIdx = Math.floor((ctx.windowStartMs + IST_OFFSET_MS) / DAY_MS);
  const windowDates: string[] = [];
  for (let di = startIdx; di <= ctx.todayIndex; di++) windowDates.push(istDateStr(di * DAY_MS - IST_OFFSET_MS));

  const reps: Record<string, RepData> = {};
  for (const ownerId of REP_OWNER_IDS) {
    const byPeriod = accs.get(ownerId)!;
    const ownedList = ownedCompanies[ownerId] ?? [];
    const ownedSet = new Set(ownedList.map((c) => c.id));
    const periods = {} as Record<PeriodKey, PeriodMetrics>;
    for (const p of PERIOD_KEYS) periods[p] = finalize(byPeriod.get(p)!, p, companyNames, companyLifecycle, contactMeta, ownedSet, ownedList);

    const dmap = dailyAcc.get(ownerId)!;
    const daily: DailyPoint[] = windowDates.map((date) => {
      const d = dmap.get(date) ?? { calls: 0, connected: 0, emails: 0 };
      return { date, calls: d.calls, connected: d.connected, emails: d.emails };
    });

    reps[ownerId] = { periods, daily };
  }

  return {
    generated_at_utc: new Date(generatedAtMs).toISOString(),
    today_ist: ctx.windowEndDate,
    week_start: "MON",
    scope: "outbound",
    sources,
    window: { start_ist: ctx.windowStartDate, end_ist: ctx.windowEndDate },
    totals: { calls: totalCalls, emails: totalEmails, reps: REP_OWNER_IDS.length, window_days: Math.round((ctx.nowMs - ctx.windowStartMs) / DAY_MS) },
    owner_names: REPS,
    reps,
  };
}
