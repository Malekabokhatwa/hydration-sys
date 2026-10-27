import copy from "./copy.json";
import { formatAmount } from "./units";
import type { Pet, Settings } from "./types";

export type Situation =
  | "log" | "reminder" | "fed" | "peckish" | "hungry" | "veryHungry"
  | "recovered" | "goal" | "morning" | "quiet" | "offHours" | "paused";

type Voice = "byte" | "chill" | "plain";
const LINES = copy as Record<Voice, Partial<Record<Situation, string[]>>>;

export function voiceOf(s: Pick<Settings, "chill" | "noJokes">): Voice {
  return s.noJokes ? "plain" : s.chill ? "chill" : "byte";
}

export function lines(s: Pick<Settings, "chill" | "noJokes">, kind: Situation): string[] {
  return LINES[voiceOf(s)][kind] ?? LINES.byte[kind] ?? [];
}

export function fill(template: string, s: Pick<Settings, "petName" | "unit" | "goalMl">, ml?: number): string {
  return template
    .replaceAll("{name}", s.petName.trim())
    .replaceAll("{ml}", ml === undefined ? "" : formatAmount(ml, s.unit))
    .replaceAll("{goal}", formatAmount(s.goalMl, s.unit));
}

/** Picks a line without repeating the previous pick for that situation. */
export class LinePicker {
  private last = new Map<string, number>();
  constructor(private random: () => number = Math.random) {}

  pick(s: Settings, kind: Situation, ml?: number): string {
    const list = lines(s, kind);
    if (list.length === 0) return "";
    let i = Math.floor(this.random() * list.length);
    const prev = this.last.get(kind);
    if (list.length > 1 && i === prev) i = (i + 1) % list.length;
    this.last.set(kind, i);
    return fill(list[i], s, ml);
  }
}

export function moodSituation(pet: Pet, paused: boolean, quiet: boolean): Situation {
  if (paused) return "paused";
  switch (pet) {
    case "goal": return "goal";
    case "sleeping": return "offHours";
    case "veryHungry": return "veryHungry";
    case "hungry": return "hungry";
    case "thirsty": return "peckish";
    case "recovering": return "recovered";
    default: return quiet ? "quiet" : "fed";
  }
}
