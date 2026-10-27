import { describe, expect, it } from "vitest";
import copy from "../../src/core/copy.json";
import { fill, LinePicker, lines } from "../../src/core/copy";
import { contrast, readable } from "../../src/core/color";
import { BODY, compose, HEIGHT, WIDTH, type PetState } from "../../src/core/sprite";
import type { Settings } from "../../src/core/types";

const S = { petName: "byte", unit: "ml", goalMl: 2000, chill: false, noJokes: false } as Settings;

describe("copy", () => {
  it("has at least 8 lines per required situation", () => {
    for (const k of ["log", "reminder", "hungry", "veryHungry", "recovered", "goal", "morning", "quiet"] as const) {
      expect(copy.byte[k].length, k).toBeGreaterThanOrEqual(8);
    }
  });
  it("never shames, threatens or makes medical claims", () => {
    const all = JSON.stringify(copy).toLowerCase();
    for (const bad of ["die", "dead", "shame", "guilt", "lazy", "doctor", "dehydrat", "health", "kidney", "you should"]) expect(all).not.toContain(bad);
  });
  it("fills placeholders and switches voice", () => {
    expect(fill("+{ml} for {name}, goal {goal}", S, 250)).toBe("+250 mL for byte, goal 2,000 mL");
    expect(lines({ chill: true, noJokes: false }, "log")).toEqual(["+{ml} logged."]);
    expect(lines({ chill: true, noJokes: true }, "log")).toEqual(["Logged {ml}."]);
  });
  it("does not repeat the previous line", () => {
    let i = 0;
    const seq = [0.1, 0.1, 0.1, 0.1];
    const p = new LinePicker(() => seq[i++ % seq.length]);
    const a = p.pick(S, "reminder");
    const b = p.pick(S, "reminder");
    expect(a).not.toBe(b);
  });
});

describe("sprite", () => {
  it("every state composes a full 16x18 grid", () => {
    for (const st of ["idle", "happy", "thirsty", "hungry", "veryHungry", "recovering", "goal", "sleeping"] as PetState[]) {
      for (const f of [0, 0.5, 1, 2, NaN]) {
        const g = compose(st, f, true);
        expect(g).toHaveLength(HEIGHT);
        g.forEach((r) => expect(r.length).toBe(WIDTH));
      }
    }
    expect(BODY).toHaveLength(HEIGHT);
  });
  it("fill level controls the water line", () => {
    const empty = compose("idle", 0).join("");
    const full = compose("idle", 1).join("");
    expect((empty.match(/g/g) ?? []).length).toBeGreaterThan(50);
    expect(full).not.toContain("g");
  });
});

describe("color", () => {
  it("keeps text readable", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    const c = readable("#4c566a", "#2e3440", "#d8dee9");
    expect(contrast(c, "#2e3440")).toBeGreaterThanOrEqual(4.5);
  });
  it("default palettes meet AA", () => {
    expect(contrast("#b4f58a", "#101410")).toBeGreaterThan(7);
    expect(contrast("#9bad91", "#101410")).toBeGreaterThan(4.5);
    expect(contrast("#9bad91", "#141a14")).toBeGreaterThan(4.5);
    expect(contrast("#ffc66d", "#130f08")).toBeGreaterThan(7);
    expect(contrast("#c2a678", "#18130b")).toBeGreaterThan(4.5);
  });
});
