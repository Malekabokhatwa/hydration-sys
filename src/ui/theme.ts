import { contrast, mix, readable } from "../core/color";
import type { Snapshot } from "../core/types";

interface Palette {
  bg: string; panel: string; inset: string; border: string;
  fg: string; dim: string; accent: string; warn: string; err: string; good: string;
  water: string; waterHi: string; waterLo: string; glass: string; ink: string; cheek: string;
}

const PHOSPHOR: Palette = {
  bg: "#101410", panel: "#141a14", inset: "#192019", border: "#2c3b2c",
  fg: "#b4f58a", dim: "#9bad91", accent: "#f6c66d", warn: "#f6c66d", err: "#ff9f9f", good: "#b4f58a",
  water: "#79d6f2", waterHi: "#d4f4ff", waterLo: "#3e9fc4", glass: "#1f3a3c", ink: "#0b1210", cheek: "#ff9f9f",
};

const AMBER: Palette = {
  bg: "#130f08", panel: "#18130b", inset: "#201910", border: "#3d3220",
  fg: "#ffc66d", dim: "#c2a678", accent: "#ffe3a3", warn: "#ffe3a3", err: "#ff9f9f", good: "#ffc66d",
  water: "#ffb84d", waterHi: "#ffe9c2", waterLo: "#c7832a", glass: "#3a2d18", ink: "#130f08", cheek: "#ff9f9f",
};

function fromOmarchy(c: Record<string, string>): Palette {
  const get = (k: string, fallback: string) => c[k] ?? fallback;
  const bg = get("background", PHOSPHOR.bg);
  const fg = get("foreground", PHOSPHOR.fg);
  const light = c.mode === "light";
  const panel = mix(bg, fg, light ? 0.03 : 0.025);
  const water = get("cyan", get("blue", PHOSPHOR.water));
  return {
    bg,
    panel,
    inset: get(light ? "lighter_background" : "dark_background", mix(bg, light ? "#ffffff" : "#000000", 0.25)),
    border: get("selection", mix(bg, fg, 0.22)),
    fg: readable(fg, bg, light ? "#000000" : "#ffffff", 7),
    dim: readable(get("light_foreground", mix(fg, bg, 0.3)), bg, fg),
    // These are used as small text, so they need full AA contrast on panels.
    accent: readable(get("accent", get("yellow", PHOSPHOR.accent)), panel, fg),
    warn: readable(get("yellow", PHOSPHOR.warn), panel, fg),
    err: readable(get("red", PHOSPHOR.err), panel, fg),
    good: readable(get("green", PHOSPHOR.good), panel, fg),
    water,
    waterHi: mix(water, "#ffffff", 0.65),
    waterLo: mix(water, "#000000", 0.3),
    glass: mix(bg, water, light ? 0.3 : 0.24),
    ink: light ? "#1a1a1a" : get("darker_background", mix(bg, "#000000", 0.5)),
    cheek: get("red", PHOSPHOR.cheek),
  };
}

export function palette(snap: Snapshot): { name: string; colors: Palette; dark: boolean } {
  const t = snap.settings.theme;
  const omarchy = snap.platform.theme;
  if (t === "omarchy" && omarchy) {
    const colors = fromOmarchy(omarchy.colors);
    return { name: `omarchy${omarchy.name ? ` · ${omarchy.name.toLowerCase()}` : ""}`, colors, dark: omarchy.colors.mode !== "light" };
  }
  if (t === "amber") return { name: "amber", colors: AMBER, dark: true };
  return { name: t === "omarchy" ? "phosphor (no omarchy theme found)" : "phosphor", colors: PHOSPHOR, dark: true };
}

let applied = "";

export function applyTheme(snap: Snapshot): string {
  const p = palette(snap);
  const key = JSON.stringify(p);
  if (key !== applied) {
    applied = key;
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(p.colors)) root.setProperty(`--${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}`, v);
    root.setProperty("color-scheme", p.dark ? "dark" : "light");
    // Selected tab / primary button text must read on the accent fill.
    root.setProperty("--on-accent", contrast(p.colors.bg, p.colors.accent) >= 4.5 ? p.colors.bg : p.colors.fg);
  }
  return p.name;
}
