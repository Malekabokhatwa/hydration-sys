// Everything in the git-style history is derived from the stored entries and
// per-day goal snapshots. Nothing here is persisted.

import { addDays, clockAt, daysBetween, prettyDay, shortDay, weekday } from "./dates";
import { formatAmount } from "./units";
import type { Entry, Unit } from "./types";

export interface Day {
  date: string;
  entries: Entry[]; // oldest first
  total: number;
  goal: number;
  met: boolean;
}

export interface Commit {
  entry: Entry;
  hash: string;
  message: string;
  runningTotal: number;
}

/** Deterministic 7-hex-digit "commit hash" from an entry id (FNV-1a). */
export function shortHash(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 7);
}

/** The goal that applied on `date`: its snapshot, else the latest earlier one, else the default. */
export function goalFor(date: string, dayGoals: Record<string, number>, fallback: number): number {
  if (dayGoals[date] !== undefined) return dayGoals[date];
  let best: string | null = null;
  for (const k of Object.keys(dayGoals)) if (k < date && (best === null || k > best)) best = k;
  return best === null ? fallback : dayGoals[best];
}

/** Every day from the first entry (or `from`) to `today`, including empty days. */
export function buildDays(entries: Entry[], dayGoals: Record<string, number>, fallbackGoal: number, today: string, minDays = 1): Day[] {
  const byDate = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = byDate.get(e.date);
    if (list) list.push(e);
    else byDate.set(e.date, [e]);
  }
  let first = today;
  for (const d of byDate.keys()) if (d < first) first = d;
  const span = Math.max(daysBetween(first, today) + 1, minDays);
  const days: Day[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const list = (byDate.get(date) ?? []).slice().sort((x, y) => x.ts - y.ts);
    const total = list.reduce((s, e) => s + e.ml, 0);
    const goal = goalFor(date, dayGoals, fallbackGoal);
    days.push({ date, entries: list, total, goal, met: total >= goal });
  }
  return days; // oldest first
}

export interface Streaks {
  current: number;
  best: number;
  todayCounts: boolean;
}

/**
 * Consecutive days that met their own goal. An unfinished today never breaks
 * yesterday's streak: it only adds once it is met.
 */
export function streaks(days: Day[]): Streaks {
  let best = 0;
  let run = 0;
  for (const d of days) {
    run = d.met ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const last = days[days.length - 1];
  let current = 0;
  let i = days.length - 1;
  const todayCounts = !!last?.met;
  if (last && !last.met) i--; // today still in progress
  for (; i >= 0 && days[i].met; i--) current++;
  return { current, best, todayCounts };
}

export type Level = 0 | 1 | 2 | 3 | 4;

/** Heatmap level by share of that day's goal, capped at goal met. */
export function level(total: number, goal: number): Level {
  if (total <= 0) return 0;
  const r = total / Math.max(goal, 1);
  if (r >= 1) return 4;
  if (r >= 2 / 3) return 3;
  if (r >= 1 / 3) return 2;
  return 1;
}

export const LEVEL_GLYPH = ["·", "░", "▒", "▓", "█"] as const;
export const LEVEL_LABEL = ["nothing logged", "under a third", "a third or more", "two thirds or more", "goal met"] as const;

export interface HeatCell {
  date: string;
  total: number;
  goal: number;
  level: Level;
  future: boolean;
}

/** Columns of 7 days (Sun..Sat), ending with the week that contains `today`. */
export function heatmap(days: Day[], today: string, weeks: number): HeatCell[][] {
  const map = new Map(days.map((d) => [d.date, d]));
  const end = addDays(today, 6 - weekday(today)); // Saturday of this week
  const start = addDays(end, -(weeks * 7 - 1));
  const cols: HeatCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: HeatCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      const day = map.get(date);
      const total = day?.total ?? 0;
      const goal = day?.goal ?? 0;
      col.push({ date, total, goal, level: date > today ? 0 : level(total, goal || 1), future: date > today });
    }
    cols.push(col);
  }
  return cols;
}

export interface Tag {
  name: string;
  date: string;
  note: string;
}

/** Cosmetic milestones, all derived. Each tag marks the first day it was earned. */
export function tags(days: Day[]): Tag[] {
  const out: Tag[] = [];
  let run = 0;
  let firstGoal = false;
  let everMet = false;
  let merges = 0;
  const seen = new Set<number>();
  days.forEach((d, i) => {
    if (d.met) {
      if (!firstGoal) {
        out.push({ name: "v1.0", date: d.date, note: "first day at goal" });
        firstGoal = true;
      }
      if (everMet && i > 0 && !days[i - 1].met && merges < 50) {
        out.push({ name: `merge #${++merges}`, date: d.date, note: "back on main after a missed day" });
      }
      run++;
      for (const n of [3, 7, 30]) {
        if (run === n && !seen.has(n)) {
          seen.add(n);
          out.push({ name: `streak-${n}`, date: d.date, note: `${n} days in a row` });
        }
      }
      everMet = true;
    } else {
      run = 0;
    }
  });
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Commit-style message for one drink, from its context in the day. */
export function commitMessage(day: Day, idx: number, unit: Unit): string {
  const e = day.entries[idx];
  const amount = formatAmount(e.ml, unit);
  const before = day.entries.slice(0, idx).reduce((s, x) => s + x.ml, 0);
  const after = before + e.ml;
  if (before >= day.goal) return `docs: +${amount} (recorded, no extra credit)`;
  if (after >= day.goal) return `release: +${amount}, daily goal reached`;
  const prev = idx > 0 ? day.entries[idx - 1] : null;
  if (idx === 0 && clockAt(e.ts, e.offsetMin) < "11:00") return `chore: morning refill +${amount}`;
  if (prev && e.ts - prev.ts >= 150 * 60_000) return `fix: +${amount} after a long gap`;
  if (e.ml >= 500) return `feat: +${amount} (big refactor)`;
  if (e.ml <= 150) return `style: +${amount} sip`;
  return `feat: +${amount}`;
}

export function commits(day: Day, unit: Unit): Commit[] {
  let running = 0;
  return day.entries.map((entry, i) => {
    running += entry.ml;
    return { entry, hash: shortHash(entry.id), message: commitMessage(day, i, unit), runningTotal: running };
  });
}

export interface LogLine {
  graph: string;
  kind: "header" | "commit" | "empty" | "spacer";
  text: string;
  date?: string;
  hash?: string;
  time?: string;
  head?: boolean;
  tags?: string[];
  met?: boolean;
}

/** `git log --graph`-ish lines, newest day first. */
export function gitLog(days: Day[], unit: Unit, opts: { oneline?: boolean; limitDays?: number } = {}): LogLine[] {
  const tagMap = new Map<string, string[]>();
  for (const t of tags(days)) tagMap.set(t.date, [...(tagMap.get(t.date) ?? []), t.name]);
  const newest = days.slice().reverse().slice(0, opts.limitDays ?? days.length);
  const lines: LogLine[] = [];
  let headDone = false;
  newest.forEach((day, di) => {
    const status = day.met ? "goal met" : day.total ? `${Math.round((day.total / day.goal) * 100)}%` : "";
    if (!opts.oneline) {
      lines.push({
        graph: "",
        kind: "header",
        date: day.date,
        text: `${prettyDay(day.date)}  ${formatAmount(day.total, unit)} / ${formatAmount(day.goal, unit)}${status ? `  ${status}` : ""}`,
        tags: tagMap.get(day.date),
        met: day.met,
      });
    }
    const cs = commits(day, unit).reverse();
    if (cs.length === 0 && !opts.oneline) {
      lines.push({ graph: "|", kind: "empty", text: "(empty day, nothing committed)", date: day.date });
    }
    cs.forEach((c) => {
      const head = !headDone;
      headDone = true;
      lines.push({
        graph: "*",
        kind: "commit",
        hash: c.hash,
        time: clockAt(c.entry.ts, c.entry.offsetMin),
        text: c.message,
        head,
        date: day.date,
      });
    });
    if (!opts.oneline && di < newest.length - 1) lines.push({ graph: "|", kind: "spacer", text: "" });
  });
  return lines;
}

export function gitLogText(days: Day[], unit: Unit, petName: string): string {
  const out: string[] = [`# hydration.sys log for ${petName}`, `# ${days.length} days, newest first`, ""];
  for (const l of gitLog(days, unit)) {
    if (l.kind === "header") {
      out.push(`commit-date ${l.text}${l.tags?.length ? `  (tag: ${l.tags.join(", tag: ")})` : ""}`);
    } else if (l.kind === "commit") {
      out.push(`* ${l.hash} ${l.time}  ${l.text}${l.head ? "  (HEAD -> main)" : ""}`);
    } else if (l.kind === "empty") {
      out.push(`|   ${l.text}`);
    } else {
      out.push("|");
    }
  }
  return out.join("\n") + "\n";
}

/** A diff-like view of one day: + lines with running totals. */
export function dayDiff(day: Day, prevDate: string, unit: Unit): string[] {
  const lines = [
    `diff --hydration a/${prevDate} b/${day.date}`,
    `@@ goal ${formatAmount(day.goal, unit)} · ${shortDay(day.date)} @@`,
  ];
  if (day.entries.length === 0) lines.push("  (no drinks logged)");
  for (const c of commits(day, unit)) {
    lines.push(`+ ${clockAt(c.entry.ts, c.entry.offsetMin)}  ${formatAmount(c.entry.ml, unit).padStart(8)}   total ${formatAmount(c.runningTotal, unit)}`);
  }
  const pct = Math.round((day.total / Math.max(day.goal, 1)) * 100);
  lines.push(`= ${formatAmount(day.total, unit)} / ${formatAmount(day.goal, unit)} (${Math.min(pct, 100)}%${pct > 100 ? ", goal met" : ""})`);
  return lines;
}

export interface Weekly {
  total: number;
  average: number;
  goalDays: number;
  loggedDays: number;
  best: Day | null;
}

export function weekly(days: Day[]): Weekly {
  const last = days.slice(-7);
  const total = last.reduce((s, d) => s + d.total, 0);
  const best = last.reduce<Day | null>((b, d) => (d.total > 0 && (!b || d.total > b.total) ? d : b), null);
  return {
    total,
    average: Math.round(total / Math.max(last.length, 1)),
    goalDays: last.filter((d) => d.met).length,
    loggedDays: last.filter((d) => d.total > 0).length,
    best,
  };
}
