import { describe, expect, it } from "vitest";
import { addDays, ago, clockAt, daysBetween, hhmmToMinutes, minutesToHHMM, weekday } from "../../src/core/dates";
import { formatAmount, mlToOz, ozToMl, parseAmount, presets } from "../../src/core/units";

describe("units", () => {
  it("converts consistently", () => {
    expect(ozToMl(1)).toBe(30);
    expect(ozToMl(8)).toBe(237);
    expect(mlToOz(2000)).toBeCloseTo(67.628, 2);
    for (const ml of [1, 150, 250, 500, 1999, 2000]) expect(Math.abs(ozToMl(mlToOz(ml)) - ml)).toBeLessThanOrEqual(1);
    for (const ml of presets("oz")) expect(ml).toBe(Math.round(ml));
  });
  it("formats", () => {
    expect(formatAmount(2000, "ml")).toBe("2,000 mL");
    expect(formatAmount(237, "oz")).toBe("8.0 oz");
    expect(formatAmount(2000, "oz")).toBe("68 oz");
  });
  it("validates amounts as whole mL 1-2000", () => {
    expect(parseAmount("250", "ml")).toEqual({ ok: true, ml: 250 });
    expect(parseAmount("0.01oz", "ml").ok).toBe(false);
    expect(parseAmount("68oz", "ml").ok).toBe(false);
    expect(parseAmount("abc", "ml").ok).toBe(false);
    expect(parseAmount("", "ml").ok).toBe(false);
  });
});

describe("calendar dates", () => {
  it("adds days across DST and month/year ends", () => {
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2026-10-01", "2026-11-01")).toBe(31);
    expect(weekday("2026-10-27")).toBe(2);
  });
  it("shows entries in the offset they were logged with", () => {
    const ts = Date.UTC(2026, 9, 27, 7, 30);
    expect(clockAt(ts, 120)).toBe("09:30");
    expect(clockAt(ts, -240)).toBe("03:30");
  });
  it("parses times", () => {
    expect(hhmmToMinutes("09:05")).toBe(545);
    expect(hhmmToMinutes("24:00")).toBe(1440);
    expect(hhmmToMinutes("25:00")).toBeNull();
    expect(minutesToHHMM(545)).toBe("09:05");
    expect(ago(0, 59_000)).toBe("just now");
    expect(ago(0, 90 * 60_000)).toBe("1h 30m ago");
  });
});
