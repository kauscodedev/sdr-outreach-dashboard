/**
 * US/Eastern (America/New_York) period bucketing.
 *
 * HubSpot stores hs_timestamp as UTC epoch-ms. The dashboard mirrors HubSpot's own
 * UI, whose portal timezone is US/Eastern, so all "today / yesterday / this week …"
 * boundaries are defined at US/Eastern civil midnight.
 *
 * US/Eastern OBSERVES daylight saving, so a fixed offset would be wrong half the year.
 * We use the runtime's built-in IANA timezone database via Intl.DateTimeFormat — no
 * external tz library needed. (This is why day *identity* is a civil-calendar ordinal,
 * NOT floor(ms / DAY): the UTC offset varies, but the calendar date does not.)
 */

import { PeriodKey } from "./types";

export const PORTAL_TZ = "America/New_York";

const DAY_MS = 86_400_000;

// Wall-clock parts (h23 so midnight is "00", never "24") in the portal timezone.
const PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: PORTAL_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// "YYYY-MM-DD" directly (en-CA yields ISO date order).
const DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: PORTAL_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function partsOf(utcMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of PARTS_FMT.formatToParts(utcMs)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Civil ordinal (whole days since epoch) for a civil Y-M-D — offset-independent. */
function civilIndex(year: number, month1to12: number, day: number): number {
  return Math.floor(Date.UTC(year, month1to12 - 1, day) / DAY_MS);
}

/** Civil (year, month, day) for a civil ordinal. */
function ymdOf(dayIndex: number): [number, number, number] {
  const d = new Date(dayIndex * DAY_MS);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

export interface EtParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  dayIndex: number; // civil days since epoch (calendar identity, offset-independent)
}

/** Civil US/Eastern date parts for a UTC epoch-ms value. */
export function etParts(utcMs: number): EtParts {
  const p = partsOf(utcMs);
  return { year: p.year, month: p.month, day: p.day, dayIndex: civilIndex(p.year, p.month, p.day) };
}

/** "YYYY-MM-DD" for a UTC epoch-ms value, in US/Eastern. */
export function etDateStr(utcMs: number): string {
  return DATE_FMT.format(utcMs);
}

/** Offset (ms) to ADD to a UTC instant to get US/Eastern wall-clock time. */
function tzOffsetMs(utcMs: number): number {
  const p = partsOf(utcMs);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - utcMs;
}

/**
 * UTC epoch-ms for US/Eastern civil midnight (00:00:00) of Y-M-D.
 * Offset-lookup + one correction pass: the first offset estimate can be on the wrong
 * side of a DST transition, so re-read the offset actually in effect at the guess.
 * US midnights never fall inside the 1-hour spring-forward gap, so one pass converges.
 */
export function etMidnightUtcMs(year: number, month1to12: number, day: number): number {
  const naive = Date.UTC(year, month1to12 - 1, day, 0, 0, 0); // wall time treated as UTC
  const guess = naive - tzOffsetMs(naive);
  return naive - tzOffsetMs(guess);
}

/** Weekday with Monday = 0 for a civil ordinal. */
function weekdayMon(dayIndex: number): number {
  const sunBased = new Date(dayIndex * DAY_MS).getUTCDay(); // 0=Sun
  return (sunBased + 6) % 7;
}

/** Everything derived once from "now", reused for every activity. */
export interface EtContext {
  nowMs: number;
  today: EtParts;
  todayIndex: number;
  weekStartIndex: number; // Monday of the current ET week
  monthStartIndex: number; // 1st of the current ET month
  dailyStartIndex: number; // earliest day the `daily` trend series should cover
  windowStartMs: number; // earliest UTC ms the 6 periods need (may be widened by the caller)
  windowStartDate: string; // YYYY-MM-DD (ET)
  windowEndDate: string; // YYYY-MM-DD (ET) = today
}

export function makeEtContext(nowMs: number): EtContext {
  const today = etParts(nowMs);
  const todayIndex = today.dayIndex;
  const weekStartIndex = todayIndex - weekdayMon(todayIndex);
  const monthIdx = civilIndex(today.year, today.month, 1);

  // Earliest boundary across the 6 periods: last-week start, last-3-days start, month start.
  const lastWeekStartIndex = weekStartIndex - 7;
  const last3StartIndex = todayIndex - 2;
  const windowStartIndex = Math.min(lastWeekStartIndex, last3StartIndex, monthIdx);

  const [wy, wm, wd] = ymdOf(windowStartIndex);
  const windowStartMs = etMidnightUtcMs(wy, wm, wd);

  return {
    nowMs,
    today,
    todayIndex,
    weekStartIndex,
    monthStartIndex: monthIdx,
    dailyStartIndex: windowStartIndex,
    windowStartMs,
    windowStartDate: etDateStr(windowStartMs),
    windowEndDate: etDateStr(nowMs),
  };
}

/** Which periods does an activity (UTC ms) fall into? An activity can match several. */
export function periodsForActivity(utcMs: number, ctx: EtContext): PeriodKey[] {
  const p = etParts(utcMs);
  const di = p.dayIndex;
  const out: PeriodKey[] = [];

  if (di === ctx.todayIndex) out.push("today");
  if (di === ctx.todayIndex - 1) out.push("yesterday");
  if (di >= ctx.todayIndex - 2 && di <= ctx.todayIndex) out.push("last_3_days");
  if (di >= ctx.weekStartIndex && di <= ctx.todayIndex) out.push("this_week");
  if (di >= ctx.weekStartIndex - 7 && di <= ctx.weekStartIndex - 1) out.push("last_week");
  if (p.year === ctx.today.year && p.month === ctx.today.month) out.push("this_month");

  return out;
}

/** Civil (year, month, day) for a civil ordinal — exported for daily-series construction. */
export function dayIndexToYmd(dayIndex: number): [number, number, number] {
  return ymdOf(dayIndex);
}

/** UTC [fromMs, toMs) window for one of the six periods — the inverse of periodsForActivity
 *  (a past activity falls in the window iff the period matches). Built from the same civil
 *  ordinals, so DST transitions inside a window are handled by etMidnightUtcMs. */
export function periodBounds(period: PeriodKey, ctx: EtContext): { fromMs: number; toMs: number } {
  const mid = (di: number) => {
    const [y, m, d] = ymdOf(di);
    return etMidnightUtcMs(y, m, d);
  };
  const t = ctx.todayIndex;
  switch (period) {
    case "today": return { fromMs: mid(t), toMs: mid(t + 1) };
    case "yesterday": return { fromMs: mid(t - 1), toMs: mid(t) };
    case "last_3_days": return { fromMs: mid(t - 2), toMs: mid(t + 1) };
    case "this_week": return { fromMs: mid(ctx.weekStartIndex), toMs: mid(t + 1) };
    case "last_week": return { fromMs: mid(ctx.weekStartIndex - 7), toMs: mid(ctx.weekStartIndex) };
    case "this_month": return { fromMs: mid(ctx.monthStartIndex), toMs: mid(t + 1) };
  }
}

/** ET midnight for a "YYYY-MM-DD", offset by `plusDays` civil days (Date.UTC handles overflow).
 *  Shared by the /api/metrics/range and /api/rep/[ownerId]/calling routes. */
export function etDayStartMs(ymd: string, plusDays = 0): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + plusDays));
  return etMidnightUtcMs(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
