/** Shared types for the sync pipeline and the dashboard. */
import { DealStageKey } from "../../config/deal-stages";
import { DemoStatus } from "./segmentation";
import { DealHealth } from "./deal-health";
export type { DemoStatus } from "./segmentation";
export type { DealHealth } from "./deal-health";

export const PERIOD_KEYS = [
  "today",
  "yesterday",
  "last_3_days",
  "this_week",
  "last_week",
  "this_month",
] as const;

export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_3_days: "Last 3 days",
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
};

/** Periods small enough to carry a per-company drill-down in the snapshot. */
export const NARROW_PERIODS: PeriodKey[] = ["today", "yesterday", "this_week"];

export type ActivityType = "call" | "email";

/** A normalized outbound activity after pull + association resolution. */
export interface Activity {
  id: string;
  type: ActivityType;
  ownerId: string;
  timestampMs: number; // UTC epoch ms (from hs_timestamp)
  disposition: string | null; // call disposition GUID (calls only)
  emailStatus: string | null; // hs_email_status (emails only)
  emailOpened: boolean;
  emailReplied: boolean;
  emailClicked: boolean;
  contactIds: string[];
  companyIds: string[];
}

/**
 * One stage transition of a deal — WHEN it entered (and, if it moved on, exited) a canonical
 * stage. Sourced from HubSpot's calculated hs_v2_date_entered/exited_<stageId> properties.
 * This is the event-truth layer: period funnel metrics count these, never current stage.
 */
export interface DealStageEvent {
  stageKey: DealStageKey;
  enteredMs: number;
  exitedMs: number | null; // null = still in this stage
}

/**
 * A HubSpot deal after pull + association resolution. Scoped to the Auto Pipeline; `stageKey`
 * is the canonical (pipeline, dealstage) normalization (see config/deal-stages.ts) so all
 * downstream logic is collision-safe. `dealstage` keeps the raw id for storage/debugging.
 */
export interface Deal {
  id: string;
  pipeline: string | null;
  dealstage: string | null; // raw HubSpot stage id
  stageKey: DealStageKey;
  dealOwnerId: string | null; // hubspot_owner_id — the AE
  sdrOwnerId: string | null; // sdr_owner — the SDR credited on the deal
  companyId: string | null; // primary associated company
  contactIds: string[];
  amount: number | null;
  createdMs?: number | null; // createdate — windows the funnel (absent pre-migration)
  demoScheduledForMs: number | null; // demo_scheduled_for_date — the SDR's commitment date
  expectedCloseMs?: number | null; // expected_contract_closure_date — the AE's commitment date
  discoveryDoneMs: number | null; // discovery_call_done_stage_date
  demoDoneMs: number | null; // demo_done_stage_date
  stageEvents?: DealStageEvent[]; // stage-event ledger, entered_ms asc (absent pre-V3)
}

export interface CallMetrics {
  total: number;
  connected: number;
  not_connected: number;
  null_disposition: number;
  connect_rate: number; // connected / (connected + not_connected), null excluded
  by_disposition: Record<string, number>; // label -> count
}

export interface EmailMetrics {
  sent: number;
  bounced: number;
  bounce_rate: number;
  opened: number;
  replied: number;
  clicked: number;
  open_rate: number;
  reply_rate: number;
  click_rate: number;
}

/** Unique entities (contacts or companies) tapped, split by which activity reached them. */
export interface ReachByChannel {
  total: number; // distinct entities tapped
  call_only: number;
  email_only: number;
  both: number;
  via_call: number; // call_only + both
  via_email: number; // email_only + both
}

/** A company reference with its lifecycle stage group. */
export interface NamedRef {
  id: string;
  name: string;
  stage?: string; // lifecycle group label
}

/**
 * GD-level pipeline stages — sourced directly from the HubSpot `lifecycle_stage_gd_level`
 * property (title-cased here). "Other" catches empty/unrecognized values. Order = display order.
 */
export const STAGE_GROUPS = ["Prospect", "In Pipeline", "Contract Closed", "Drop Off", "Other"] as const;
export type StageGroup = (typeof STAGE_GROUPS)[number];

/** A count pair for one coverage dimension: total units vs tapped units. */
export interface CoverageDim {
  total: number;
  tapped: number;
}

/** Market-segment sizes (HubSpot `market_segment` enum). */
export const MARKET_SEGMENTS = [
  "smb", "mm_single", "mm_group", "enterprise_a", "enterprise_b", "enterprise_c", "top_150", "unsized",
] as const;
export type MarketSegment = (typeof MARKET_SEGMENTS)[number];

export const MARKET_SEGMENT_LABELS: Record<MarketSegment, string> = {
  smb: "SMB",
  mm_single: "MM · Single",
  mm_group: "MM · Group",
  enterprise_a: "Ent A",
  enterprise_b: "Ent B",
  enterprise_c: "Ent C",
  top_150: "Top 150",
  unsized: "Unsized",
};

export type DealershipType = "Franchise" | "Independent" | "Unknown";

export type Temperature = "hot" | "warm" | "cold";

/**
 * Enriched last-activity summary for an account (from our synced calls/emails; GD-rolled to the
 * most-recent rooftop touch). Names resolve via owner_names / the rooftop's contacts.
 */
export interface LastActivity {
  ms: number | null;
  type: "call" | "email" | null;
  owner_id: string | null; // who did it (activity doer)
  contact_name: string | null; // the contact on that most-recent touch
  outcome: string | null; // disposition label (call) or email status
}

/**
 * Per-account deal snapshot — the "demo → closure" facet. The FURTHEST live Auto-Pipeline deal
 * governs. `health` is set only for accounts with a live advanced deal (Demo Scheduled/Done);
 * for Demo-Pending accounts it's null and Temperature governs instead (the two-indicator model).
 */
export interface AccountDeal {
  demo_status: DemoStatus;
  at_risk: boolean; // scheduled demo that bounced / whose date passed
  has_revivable: boolean; // only dead deals — previously worked, re-workable
  stage: string | null; // furthest live stage label
  stage_key: DealStageKey | null;
  health: DealHealth | null; // null when demo_pending
  health_reason: string | null;
  deal_count: number;
}

/** One engaged contact on a rooftop, with its own activity recency + temperature. */
export interface RooftopContact {
  id: string;
  name: string;
  title?: string;
  dm?: boolean;
  calls: number;
  emails: number;
  last_ms: number; // epoch ms of this contact's most recent touch
  last_type: "call" | "email"; // channel of that most recent touch
  temp: Temperature; // per-contact temperature (same engine as the account)
}

/** Owner-recency coverage of a rooftop/unit over a 60-day window: "tapped" = the account OWNER
 *  worked it ≤60d; "worked_by_other" = only a DIFFERENT tracked rep did (owner didn't); "untapped" =
 *  no tracked activity ≤60d. `tapped` (kept for back-compat) mirrors coverage === "tapped". */
export type CoverageStatus = "tapped" | "worked_by_other" | "untapped";

/** One owned rooftop inside a book unit — cumulative, owner-scoped engagement. */
export interface RooftopDetail {
  id: string;
  name: string;
  tapped: boolean; // coverage === "tapped" (owner worked it in the 60-day window)
  coverage: CoverageStatus; // owner-recency bucket
  calls: number; // outbound calls by the OWNING rep (anchor window)
  emails: number;
  connected: number; // calls that reached a human
  opened: number; // emails opened
  replied: number; // emails replied
  meetings: number; // meeting-scheduled outcomes
  high_intent: number; // high-intent outcomes (meeting/reschedule/callback-high)
  negative: number; // disqualifying outcomes
  disqualified: boolean; // latest signal is a live rejection
  last_ms: number | null; // epoch ms of the rep's latest touch; null if untapped
  temp: Temperature; // cumulative temperature ("cold" + reason "Untouched" when untapped)
  temp_reason: string;
  deal?: AccountDeal; // deal-derived demo-status + health (present once deals are synced)
  last_activity?: LastActivity; // enriched last touch (owner/contact/outcome)
  contacts: RooftopContact[]; // engaged contacts, most-engaged first
}

/** A GD/Single unit with rooftop drill-down — the Book Explorer's data. */
export interface BookUnitDetail {
  key: string; // `gd:${gdId}` or `single:${companyId}`
  name: string;
  isGroup: boolean;
  stage: StageGroup;
  dealership: DealershipType;
  segment: MarketSegment;
  tapped: boolean; // coverage === "tapped"
  coverage: CoverageStatus; // owner-recency bucket for the unit (tapped if ANY rooftop is owner-recent)
  mixed_owner: boolean; // GD whose rooftops are owned by >1 tracked rep — only partially this rep's book
  temp: Temperature; // unit-level temperature (aggregated from rooftops for GD, single rooftop for single unit)
  temp_reason: string; // why this temperature
  rooftops: RooftopDetail[]; // tapped first (by calls+emails desc), then untapped (name asc)
}

/**
 * Coverage of a rep's owned book, rolled up to GD/Single units. "Tapped" = the OWNER worked a
 * rooftop of the unit within the last 60 days (owner-recency, NOT "ever" and NOT another rep).
 * A unit the owner hasn't worked in 60d but a different tracked rep has → worked_by_other (its own
 * bucket, not counted as tapped or untapped). Drop-off / junk accounts stay in the denominator as
 * long as they are still owned by the rep.
 */
export interface BookCoverage {
  units_total: number; // distinct GD/single units owned
  units_tapped: number; // units the OWNER worked in the last 60 days (>=1 rooftop)
  units_worked_by_other: number; // NOT owner-tapped, but a different tracked rep worked it ≤60d
  units_mixed_owner: number; // GD units whose rooftops span >1 tracked owner (partial ownership)
  pct: number; // units_tapped / units_total
  rooftops_total: number; // raw owned rooftops (reference)
  gds: number; // distinct group units
  singles: number; // single units
  by_stage: Record<StageGroup, CoverageDim>; // GD-level, furthest-along stage
  by_dealership: Record<DealershipType, CoverageDim>;
  by_segment: Record<MarketSegment, CoverageDim>;
  by_group_kind: { group: CoverageDim; single: CoverageDim }; // GDs vs Singles
  units: BookUnitDetail[]; // groups first (rooftop count desc), then singles; name asc tiebreak
  untapped_sample: NamedRef[]; // capped untapped units
  insights: Insight[]; // coverage-specific callouts
}

/** Tapped accounts classified by engagement temperature. */
export interface AccountTemp {
  hot: number; // meeting booked or high-intent
  warm: number; // connected / multi-touched
  cold: number; // touched but never connected
}

export interface QualitySub {
  conversations: number; // 0-100 each
  depth: number;
  persistence: number;
  channel: number;
  deliverability: number;
}

export interface QualityScore {
  score: number; // 0-100 weighted
  grade: string; // A / B / C / D / F
  sub: QualitySub;
}

export type InsightLevel = "good" | "warn" | "info";

export interface Insight {
  level: InsightLevel;
  text: string;
}

export interface ContactRef {
  id: string;
  name: string;
  title?: string;
  dm?: boolean; // decision-maker
}

export interface CompanyBreakdownRow {
  id: string;
  name: string;
  contacts: number;
  calls: number;
  emails: number;
  connected: number; // calls that reached a human
  meetings: number; // meeting-scheduled outcomes
  high_intent: number; // high-intent outcomes
  negative: number; // disqualifying outcomes
  disqualified: boolean; // latest signal is a live rejection
  temp: Temperature;
  temp_reason: string; // why this tier
  stage?: string; // lifecycle group label
  opened: number; // emails opened
  replied: number; // emails replied
  last_ms: number | null; // epoch ms of the account's most recent touch this period
  owned: boolean; // is this company in the rep's owned book?
  deal?: AccountDeal; // deal-derived demo-status + health (owned accounts with deals)
  contacts_list?: RooftopContact[]; // engaged contacts w/ recency + temp (narrow periods)
}

/** One IST calendar day of a rep's activity — for the per-rep trend chart. */
export interface DailyPoint {
  date: string; // YYYY-MM-DD (IST)
  calls: number;
  connected: number;
  emails: number;
}

export interface PeriodMetrics {
  // Volume
  calls: CallMetrics;
  emails: EmailMetrics;
  meetings_booked: number;
  // Reach (unique, split by activity)
  contacts: ReachByChannel;
  companies: ReachByChannel;
  companies_with_contact: number;
  avg_contacts_per_company: number;
  multitouch_contacts: number; // contacts touched 2+ times
  multitouch_accounts: number; // companies touched 2+ times
  // Decision-maker reach (by seniority / job title)
  dm_contacts: number; // unique decision-maker contacts tapped
  titled_contacts: number; // unique tapped contacts that have a job title
  // Account temperature (tapped accounts)
  temp: AccountTemp;
  // Quality
  quality: QualityScore;
  // Insights (rule-based callouts)
  insights: Insight[];
  unattributed_activities: number;
  company_breakdown?: CompanyBreakdownRow[]; // narrow periods only
  /** Event-truth demo funnel for the period: deals that ENTERED Discovery Call Done (scheduled)
   *  / first entered Demo Done/Accepted/In Discussion (completed) within it. From the stage-event
   *  ledger, so counts don't shrink as deals advance. Absent on pre-V3 snapshots. */
  demos?: { scheduled: number; completed: number };
}

/**
 * Per-calendar-month engagement over the rep's OWNED book (US/Eastern months). "New" =
 * first-ever worked that month (the account/contact had no activity before the month started,
 * over the coverage-anchor history) — the manager view of fresh accounts vs the whole book.
 */
export interface MonthMetrics {
  month: string; // YYYY-MM (US/Eastern)
  label: string; // e.g. "Jul 2026"
  rooftops_engaged: number; // owned rooftops with >=1 touch this month (any tracked doer)
  rooftops_new: number; // of those, first-ever worked this month
  gds_engaged: number; // distinct owned GD units touched this month
  singles_engaged: number;
  contacts_engaged: number; // distinct contacts engaged on owned rooftops this month
  contacts_new: number; // of those, first-ever engaged this month
  calls: number;
  emails: number;
  connected: number;
}

/**
 * SDR demo-status funnel over the rep's OWNED book (company-owner attributed). Counts are per
 * owned rooftop. `scheduled_at_risk` is the subset of demo_scheduled that bounced / slipped.
 */
export interface RepFunnel {
  demo_pending: number;
  demo_scheduled: number;
  demo_done: number;
  scheduled_at_risk: number;
}

/**
 * Active/inactive segregation of the rep's ATTRIBUTED deals (SDR: sdr_owner; AE: hubspot_owner_id),
 * by CURRENT stage. active splits into the two motions: pre-demo (SDR, MQL→Demo Rescheduled) and
 * post-demo (AE, Demo Done→Contract Initiated). parked = Future Prospect (shelved by decision);
 * won includes Transferred-to-CS (successful exit); lost = drop-offs + Non SAL. `total` counts all
 * attributed Auto-Pipeline deals, including out-of-funnel stages ("other"), so it can exceed the
 * bucket sum. Period-independent.
 */
export interface RepPipeline {
  total: number;
  active: number;
  active_pre_demo: number;
  active_post_demo: number;
  parked: number;
  won: number;
  lost: number;
  by_stage: Partial<Record<DealStageKey, number>>; // ACTIVE deals by current stage
}

export interface RepData {
  periods: Record<PeriodKey, PeriodMetrics>;
  daily: DailyPoint[]; // one point per ET day in the (short) window
  book: BookCoverage; // cumulative owned-book coverage — period-independent
  monthly: MonthMetrics[]; // last 3 US/Eastern months, newest first
  funnel: RepFunnel; // deal-driven Demo Pending / Scheduled / Done over the owned book
  pipeline?: RepPipeline; // active/inactive deal segregation (absent on pre-V3 snapshots)
}

export interface Snapshot {
  generated_at_utc: string;
  today_et: string; // YYYY-MM-DD (US/Eastern)
  week_start: "MON";
  tz: string; // IANA timezone the boundaries are computed in
  scope: "outbound";
  /** Which HubSpot object types the token could actually read this run. */
  sources: { calls: boolean; emails: boolean };
  window: { start_et: string; end_et: string };
  totals: { calls: number; emails: number; reps: number; window_days: number };
  owner_names: Record<string, string>;
  owner_kinds: Record<string, "sdr" | "ae">; // rep type — drives the SDR/AE toggle (managers/admins)
  reps: Record<string, RepData>;
}
