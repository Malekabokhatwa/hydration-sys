import { describe, expect, it } from "vitest";
import { buildDays, commitMessage, dayDiff, gitLog, gitLogText, goalFor, heatmap, level, shortHash, streaks, tags, weekly } from "../../src/core/history";
import type { Entry } from "../../src/core/types";

let n = 0;
function e(date: string, hh: number, ml: number): Entry {
  const [y, m, d] = date.split("-").map(Number);
  return { id: `id${n++}`, ts: Date.UTC(y, m - 1, d, hh), date, ml, offsetMin: 0 };
}

describe("hashes", () => {
  it("are deterministic 7-hex and differ by id", () => {
    expect(shortHash("abc")).toBe(shortHash("abc"));
    expect(shortHash("abc")).toMatch(/^[0-9a-f]{7}$/);
    expect(shortHash("abc")).not.toBe(shortHash("abd"));
  });
});

describe("days, goals and streaks", () => {
  const goals = { "2026-10-20": 2000, "2026-10-24": 1500 };
  it("uses the goal snapshot of each day", () => {
    expect(goalFor("2026-10-20", goals, 9)).toBe(2000);
    expect(goalFor("2026-10-22", goals, 9)).toBe(2000);
    expect(goalFor("2026-10-25", goals, 9)).toBe(1500);
    expect(goalFor("2026-10-01", goals, 9)).toBe(9);
  });
  it("includes empty days and counts streaks", () => {
    const entries = [e("2026-10-20", 9, 2000), e("2026-10-22", 9, 2000), e("2026-10-23", 9, 2000), e("2026-10-24", 9, 1500), e("2026-10-25", 9, 100)];
    const days = buildDays(entries, goals, 2000, "2026-10-25");
    expect(days.map((d) => d.date)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(days[1].entries).toEqual([]);
    // today unfinished: yesterday's streak of 3 survives
    expect(streaks(days)).toEqual({ current: 3, best: 3, todayCounts: false });
    const done = buildDays([...entries, e("2026-10-25", 12, 1400)], goals, 2000, "2026-10-25");
    expect(streaks(done)).toEqual({ current: 4, best: 4, todayCounts: true });
  });
  it("a goal change does not rewrite past days", () => {
    const entries = [e("2026-10-20", 9, 1800)];
    expect(buildDays(entries, { "2026-10-20": 1800 }, 3000, "2026-10-21")[0].met).toBe(true);
  });
  it("undo/delete is just recomputation", () => {
    const entries = [e("2026-10-25", 9, 1000), e("2026-10-25", 10, 1000)];
    expect(buildDays(entries, {}, 2000, "2026-10-25").at(-1)!.met).toBe(true);
    expect(buildDays(entries.slice(0, 1), {}, 2000, "2026-10-25").at(-1)!.met).toBe(false);
  });
});

describe("heatmap", () => {
  it("has 5 levels capped at goal met", () => {
    expect(level(0, 2000)).toBe(0);
    expect(level(100, 2000)).toBe(1);
    expect(level(700, 2000)).toBe(2);
    expect(level(1400, 2000)).toBe(3);
    expect(level(2000, 2000)).toBe(4);
    expect(level(9000, 2000)).toBe(4);
  });
  it("lays out whole weeks ending this week", () => {
    const days = buildDays([e("2026-10-27", 9, 2000)], {}, 2000, "2026-10-27");
    const cols = heatmap(days, "2026-10-27", 12);
    expect(cols).toHaveLength(12);
    expect(cols.every((c) => c.length === 7)).toBe(true);
    const last = cols[11];
    expect(last[0].date).toBe("2026-10-25"); // Sunday
    expect(last[2]).toMatchObject({ date: "2026-10-27", level: 4 });
    expect(last[3].future).toBe(true);
  });
});

describe("tags and messages", () => {
  it("derives v1.0, streaks and merges", () => {
    const dates = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05"];
    const days = buildDays(dates.map((d) => e(d, 9, 2000)), {}, 2000, "2026-10-05");
    const names = tags(days).map((t) => `${t.name}@${t.date}`);
    expect(names).toContain("v1.0@2026-10-01");
    expect(names).toContain("streak-3@2026-10-03");
    expect(names).toContain("merge #1@2026-10-05");
  });
  it("gives no extra credit after the goal", () => {
    const days = buildDays([e("2026-10-01", 8, 300), e("2026-10-01", 12, 1800), e("2026-10-01", 15, 500)], {}, 2000, "2026-10-01");
    const d = days[0];
    expect(commitMessage(d, 0, "ml")).toMatch(/^chore: morning refill/);
    expect(commitMessage(d, 1, "ml")).toMatch(/^release: .*goal reached/);
    expect(commitMessage(d, 2, "ml")).toMatch(/no extra credit/);
  });
  it("renders git log, text export and diff", () => {
    const days = buildDays([e("2026-10-01", 9, 250), e("2026-10-03", 9, 2000)], {}, 2000, "2026-10-03");
    const lines = gitLog(days, "ml");
    expect(lines.filter((l) => l.kind === "header")).toHaveLength(3);
    expect(lines.find((l) => l.kind === "commit")!.head).toBe(true);
    expect(lines.some((l) => l.kind === "empty")).toBe(true);
    const txt = gitLogText(days, "ml", "byte");
    expect(txt).toContain("(HEAD -> main)");
    expect(txt).toContain("(empty day, nothing committed)");
    expect(gitLog(days, "ml", { oneline: true }).every((l) => l.kind === "commit")).toBe(true);
    const diff = dayDiff(days[2], "2026-10-02", "ml");
    expect(diff[0]).toBe("diff --hydration a/2026-10-02 b/2026-10-03");
    expect(diff.at(-1)).toContain("100%");
  });
  it("summarizes a week", () => {
    const days = buildDays([e("2026-10-01", 9, 2000), e("2026-10-02", 9, 1000)], {}, 2000, "2026-10-07");
    expect(weekly(days)).toMatchObject({ total: 3000, goalDays: 1, loggedDays: 2 });
  });
});
