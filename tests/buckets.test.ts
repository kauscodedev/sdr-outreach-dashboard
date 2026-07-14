import { describe, it, expect } from "vitest";
import { makeEtContext, periodsForActivity, etDateStr, etMidnightUtcMs, periodBounds, etDayStartMs } from "../lib/sync/buckets";
import { PERIOD_KEYS } from "../lib/sync/types";

const DAY_MS = 86_400_000;
// Noon ET on a fixed day, expressed in UTC. 2026-06-29 is a Monday; June is EDT (UTC-4),
// so 12:00 EDT = 16:00 UTC.
const NOW = Date.UTC(2026, 5, 29, 16, 0, 0);

// Civil (Y,M,D) for a day-index ordinal, then noon ET for that day expressed in UTC ms.
const ymd = (di: number): [number, number, number] => {
  const d = new Date(di * DAY_MS);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
};
const noonEt = (di: number) => {
  const [y, m, d] = ymd(di);
  return etMidnightUtcMs(y, m, d) + 12 * 3600_000;
};

describe("ET date conversion (DST-aware)", () => {
  it("rolls a late-UTC activity into the correct ET day in summer (EDT, UTC-4)", () => {
    // 2026-06-30 03:30 UTC = 2026-06-29 23:30 EDT -> still the 29th
    expect(etDateStr(Date.UTC(2026, 5, 30, 3, 30))).toBe("2026-06-29");
    // 2026-06-30 04:30 UTC = 2026-06-30 00:30 EDT -> the 30th
    expect(etDateStr(Date.UTC(2026, 5, 30, 4, 30))).toBe("2026-06-30");
  });

  it("rolls correctly in winter (EST, UTC-5)", () => {
    // 2026-01-15 04:30 UTC = 2026-01-14 23:30 EST -> the 14th
    expect(etDateStr(Date.UTC(2026, 0, 15, 4, 30))).toBe("2026-01-14");
    // 2026-01-15 05:30 UTC = 2026-01-15 00:30 EST -> the 15th
    expect(etDateStr(Date.UTC(2026, 0, 15, 5, 30))).toBe("2026-01-15");
  });
});

describe("etMidnightUtcMs across DST transitions", () => {
  it("uses UTC-4 in summer and UTC-5 in winter", () => {
    // 2026-07-01 00:00 EDT = 04:00 UTC
    expect(etMidnightUtcMs(2026, 7, 1)).toBe(Date.UTC(2026, 6, 1, 4, 0, 0));
    // 2026-01-15 00:00 EST = 05:00 UTC
    expect(etMidnightUtcMs(2026, 1, 15)).toBe(Date.UTC(2026, 0, 15, 5, 0, 0));
  });

  it("handles the spring-forward and fall-back boundary days", () => {
    // DST starts 2026-03-08 02:00. Midnight of the 8th is still EST (UTC-5).
    expect(etMidnightUtcMs(2026, 3, 8)).toBe(Date.UTC(2026, 2, 8, 5, 0, 0));
    // Midnight of the 9th is EDT (UTC-4).
    expect(etMidnightUtcMs(2026, 3, 9)).toBe(Date.UTC(2026, 2, 9, 4, 0, 0));
    // DST ends 2026-11-01 02:00. Midnight of the 1st is still EDT (UTC-4).
    expect(etMidnightUtcMs(2026, 11, 1)).toBe(Date.UTC(2026, 10, 1, 4, 0, 0));
  });
});

describe("periodsForActivity", () => {
  const ctx = makeEtContext(NOW);

  it("an activity 'now' is in today, last_3_days, this_week, this_month", () => {
    const ps = periodsForActivity(NOW, ctx);
    expect(ps).toContain("today");
    expect(ps).toContain("last_3_days");
    expect(ps).toContain("this_week");
    expect(ps).toContain("this_month");
    expect(ps).not.toContain("yesterday");
    expect(ps).not.toContain("last_week");
  });

  it("yesterday is yesterday + last_3_days, not today", () => {
    const ps = periodsForActivity(NOW - DAY_MS, ctx);
    expect(ps).toContain("yesterday");
    expect(ps).toContain("last_3_days");
    expect(ps).not.toContain("today");
  });

  it("3 days ago is NOT in last_3_days (today + 2 prior only)", () => {
    const ps = periodsForActivity(NOW - 3 * DAY_MS, ctx);
    expect(ps).not.toContain("last_3_days");
  });

  it("Monday week-start boundary: this-week starts Monday, last-week is the prior Mon-Sun", () => {
    const thisMonday = periodsForActivity(noonEt(ctx.weekStartIndex), ctx);
    expect(thisMonday).toContain("this_week");
    expect(thisMonday).not.toContain("last_week");

    const lastSunday = periodsForActivity(noonEt(ctx.weekStartIndex - 1), ctx);
    expect(lastSunday).toContain("last_week");
    expect(lastSunday).not.toContain("this_week");

    const lastMonday = periodsForActivity(noonEt(ctx.weekStartIndex - 7), ctx);
    expect(lastMonday).toContain("last_week");
  });

  it("window start covers the earliest needed boundary", () => {
    expect(ctx.windowStartMs).toBeLessThanOrEqual(noonEt(ctx.weekStartIndex - 7));
    expect(ctx.windowStartMs).toBeLessThanOrEqual(NOW - 2 * DAY_MS);
  });
});

describe("periodBounds", () => {
  // NOW is Monday 2026-06-29 noon ET (EDT) — week start == today, month start June 1.
  const ctx = makeEtContext(NOW);

  it("today spans ET midnight to next ET midnight", () => {
    const b = periodBounds("today", ctx);
    expect(b.fromMs).toBe(etMidnightUtcMs(2026, 6, 29));
    expect(b.toMs).toBe(etMidnightUtcMs(2026, 6, 30));
  });

  it("yesterday is the single prior ET day", () => {
    const b = periodBounds("yesterday", ctx);
    expect(b.fromMs).toBe(etMidnightUtcMs(2026, 6, 28));
    expect(b.toMs).toBe(etMidnightUtcMs(2026, 6, 29));
  });

  it("last_3_days = today + 2 prior days", () => {
    const b = periodBounds("last_3_days", ctx);
    expect(b.fromMs).toBe(etMidnightUtcMs(2026, 6, 27));
    expect(b.toMs).toBe(etMidnightUtcMs(2026, 6, 30));
  });

  it("this_week starts Monday; last_week is the prior Mon–Sun", () => {
    const tw = periodBounds("this_week", ctx);
    expect(tw.fromMs).toBe(etMidnightUtcMs(2026, 6, 29)); // NOW is a Monday
    expect(tw.toMs).toBe(etMidnightUtcMs(2026, 6, 30));
    const lw = periodBounds("last_week", ctx);
    expect(lw.fromMs).toBe(etMidnightUtcMs(2026, 6, 22));
    expect(lw.toMs).toBe(etMidnightUtcMs(2026, 6, 29));
  });

  it("this_month starts on the 1st", () => {
    const b = periodBounds("this_month", ctx);
    expect(b.fromMs).toBe(etMidnightUtcMs(2026, 6, 1));
    expect(b.toMs).toBe(etMidnightUtcMs(2026, 6, 30));
  });

  it("agrees with periodsForActivity for every period (incl. across the DST fall-back week)", () => {
    // 2026-11-04 is the Wednesday after DST ends (Nov 1) — last_week straddles the transition.
    const dstCtx = makeEtContext(Date.UTC(2026, 10, 4, 17, 0, 0)); // noon EST
    for (const c of [ctx, dstCtx]) {
      for (const p of PERIOD_KEYS) {
        const { fromMs, toMs } = periodBounds(p, c);
        // Just inside both edges → the period matches; just outside → it doesn't.
        expect(periodsForActivity(fromMs, c)).toContain(p);
        expect(periodsForActivity(toMs - 1, c)).toContain(p);
        expect(periodsForActivity(fromMs - 1, c)).not.toContain(p);
        // Upper edge: bounds cut at end-of-today, but periodsForActivity would also match
        // FUTURE days of the current month — unreachable for real activities, so skip it there.
        if (p !== "this_month") expect(periodsForActivity(toMs, c)).not.toContain(p);
      }
    }
  });
});

describe("etDayStartMs", () => {
  it("returns ET midnight for a YYYY-MM-DD and offsets by civil days across month ends", () => {
    expect(etDayStartMs("2026-06-29")).toBe(etMidnightUtcMs(2026, 6, 29));
    expect(etDayStartMs("2026-06-30", 1)).toBe(etMidnightUtcMs(2026, 7, 1)); // overflows into July
  });
});
