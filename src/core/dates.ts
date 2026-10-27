// Calendar arithmetic on "YYYY-MM-DD" strings. Dates are treated as plain
// calendar days (via UTC), so DST can never shift a day.

const DAY = 86_400_000;

export function parseDay(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function dayKey(utcMs: number): string {
  const d = new Date(utcMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function addDays(key: string, n: number): string {
  return dayKey(parseDay(key) + n * DAY);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b) - parseDay(a)) / DAY);
}

/** 0 = Sunday. */
export function weekday(key: string): number {
  return new Date(parseDay(key)).getUTCDay();
}

const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MO = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function prettyDay(key: string): string {
  const d = new Date(parseDay(key));
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function shortDay(key: string): string {
  const d = new Date(parseDay(key));
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
}

/** Wall-clock HH:MM of an entry in the offset it was logged with. */
export function clockAt(ts: number, offsetMin: number): string {
  const d = new Date(ts + offsetMin * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function minutesToHHMM(min: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(min / 60))}:${p(min % 60)}`;
}

export function hhmmToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h === 24 && mi === 0) return 1440;
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function ago(fromMs: number, nowMs: number): string {
  const min = Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m ago` : `${h}h ago`;
}
