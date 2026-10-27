// Contrast helpers used to keep any Omarchy theme readable.

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export function mix(a: string, b: string, t: number): string {
  const p = hexToRgb(a);
  const q = hexToRgb(b);
  if (!p || !q) return a;
  const c = p.map((v, i) => Math.round(v + (q[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** `fg` if it reads on `bg` at `min` contrast, else the closest blend toward `strong` that does. */
export function readable(fg: string, bg: string, strong: string, min = 4.5): string {
  if (contrast(fg, bg) >= min) return fg;
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const c = mix(fg, strong, t);
    if (contrast(c, bg) >= min) return c;
  }
  return strong;
}
