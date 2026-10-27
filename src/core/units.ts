import type { Unit } from "./types";

export const ML_PER_OZ = 29.5735;
export const MIN_ML = 1;
export const MAX_ML = 2000;

export function mlToOz(ml: number): number {
  return ml / ML_PER_OZ;
}

export function ozToMl(oz: number): number {
  return Math.round(oz * ML_PER_OZ);
}

export function formatAmount(ml: number, unit: Unit): string {
  if (unit === "ml") return `${Math.round(ml).toLocaleString("en-US")} mL`;
  const oz = mlToOz(ml);
  return `${oz >= 10 ? oz.toFixed(0) : oz.toFixed(1)} oz`;
}

/** Quick-add presets in the user's unit (values stored in mL). */
export function presets(unit: Unit): number[] {
  return unit === "ml" ? [150, 250, 500] : [148, 237, 473];
}

export type AmountResult = { ok: true; ml: number } | { ok: false; error: string };

/**
 * Parses user input into whole mL. Accepts "250", "250ml", "8oz", "8 oz".
 * A bare number is read in the current unit.
 */
export function parseAmount(raw: string, unit: Unit): AmountResult {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(\d+(?:\.\d+)?)(ml|oz)?$/.exec(s);
  if (!m) return { ok: false, error: "enter a number, like 250 or 8oz" };
  const n = Number(m[1]);
  const u = (m[2] as Unit | undefined) ?? unit;
  if (u === "ml" && !Number.isInteger(n)) return { ok: false, error: "mL must be a whole number" };
  const ml = u === "ml" ? n : ozToMl(n);
  if (ml < MIN_ML || ml > MAX_ML) {
    return { ok: false, error: `one drink is ${MIN_ML}-${MAX_ML} mL (${formatAmount(MAX_ML, "oz")} max)` };
  }
  return { ok: true, ml };
}
