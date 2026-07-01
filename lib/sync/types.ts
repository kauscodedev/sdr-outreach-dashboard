/** Shared types for the sync pipeline and the dashboard. */

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

/** Lead / In-pipeline / Converted groupings of the lifecycle stage ("gd level"). */
export const STAGE_GROUPS = ["Converted", "In-pipeline", "Lead/MQL", "Other"] as const;
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

/**
 * One owned "unit" at Group-Dealership / Single granularity. A group unit collapses all
 * of the rep's owned rooftops that share a gd_id; a single is a lone rooftop.
 */
export interface BookUnit {
  key: string; // `gd:${gdId}` for a group, `single:${companyId}` otherwise
  name: string;
  isGroup: boolean;
  rooftops: number; // # owned rooftops in this unit
  tapped: boolean; // any owned rooftop tapped by the OWNING rep (cumulative)
  stage: StageGroup; // furthest-along stage among the unit's rooftops
  dealership: DealershipType;
  segment: MarketSegment;
}

/**
 * Cumulative coverage of a rep's owned book, rolled up to GD/Single units. Monotonic: a
 * unit stays tapped once the owning rep has ever put an outbound activity on any of its
 * rooftops (over the coverage-anchor window). Drop-off / junk accounts stay in the
 * denominator as long as they are still owned by the rep.
 */
export interface BookCoverage {
  units_total: number; // distinct GD/single units owned
  units_tapped: number; // units with >=1 rooftop tapped by the owner
  pct: number; // units_tapped / units_total
  rooftops_total: number; // raw owned rooftops (reference)
  gds: number; // distinct group units
  singles: number; // single units
  by_stage: Record<StageGroup, CoverageDim>; // GD-level, furthest-along stage
  by_dealership: Record<DealershipType, CoverageDim>;
  by_segment: Record<MarketSegment, CoverageDim>;
  by_group_kind: { group: CoverageDim; single: CoverageDim }; // GDs vs Singles
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

export type Temperature = "hot" | "warm" | "cold";

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
  temp: Temperature;
  temp_reason: string; // why this tier
  stage?: string; // lifecycle group label
  opened: number; // emails opened
  replied: number; // emails replied
  owned: boolean; // is this company in the rep's owned book?
  contacts_list?: ContactRef[]; // who, with HubSpot record links (narrow periods)
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
}

export interface RepData {
  periods: Record<PeriodKey, PeriodMetrics>;
  daily: DailyPoint[]; // one point per ET day in the (short) window
  book: BookCoverage; // cumulative owned-book coverage — period-independent
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
  reps: Record<string, RepData>;
}
