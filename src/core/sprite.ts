// Byte, drawn as a 16x18 character grid. The same grid renders the pet in the
// app (SVG rects) and the app/tray icons (scripts/gen-icons.mjs).
//
// Palette keys:
//   .  transparent    o  outline       b  body (water)    l  highlight
//   s  body shade     e  eye           w  eye shine       c  cheek
//   m  mouth          g  empty glass (body above the water line)

export type PetState =
  | "idle"
  | "happy"
  | "thirsty"
  | "hungry"
  | "veryHungry"
  | "recovering"
  | "goal"
  | "sleeping";

export const WIDTH = 16;
export const HEIGHT = 18;

export const BODY: readonly string[] = [
  ".......oo.......",
  "......obbo......",
  "......obbo......",
  ".....obblbo.....",
  "....obblbbbo....",
  "...obblbbbbbo...",
  "..obblbbbbbbbo..",
  "..oblbbbbbbbbo..",
  ".obbbbbbbbbbbbo.",
  ".obbbbbbbbbbbbo.",
  ".obbbbbbbbbbbbo.",
  ".obbbbbbbbbbbbo.",
  ".obbbbbbbbbbbbo.",
  ".obbbbbbbbbbbbo.",
  "..obbbbbbbbbbo..",
  "..ossbbbbbbsso..",
  "...oossssssoo...",
  "....oo....oo....",
];

// Face rows 10-13 per expression. Each row is the full 16-column row.
const FACES: Record<string, readonly string[]> = {
  open: [
    ".obbeebbbbeebbo.",
    ".obbewbbbbewbbo.",
    ".obcbbbbbbbbcbo.",
    ".obbbbbmmbbbbbo.",
  ],
  blink: [
    ".obbbbbbbbbbbbo.",
    ".obbeebbbbeebbo.",
    ".obcbbbbbbbbcbo.",
    ".obbbbbmmbbbbbo.",
  ],
  happy: [
    ".obbbebbbbebbbo.",
    ".obbebebbebebbo.",
    ".obcbbbbbbbbcbo.",
    ".obbbbmmmmbbbbo.",
  ],
  lookUp: [
    ".obbeebbbbeebbo.",
    ".obbwwbbbbwwbbo.",
    ".obbbbbbbbbbbbo.",
    ".obbbbbmmbbbbbo.",
  ],
  sad: [
    ".obbbbbbbbbbbbo.",
    ".obeeebbbbeeebo.",
    ".obcbbbmmbbbcbo.",
    ".obbbbmbbmbbbbo.",
  ],
  drained: [
    ".obbbbbbbbbbbbo.",
    ".obeeebbbbeeebo.",
    ".obbbbbbbbbbbbo.",
    ".obbbbbbmbbbbbo.",
  ],
  sleep: [
    ".obbbbbbbbbbbbo.",
    ".obbeebbbbeebbo.",
    ".obbbbbbbbbbbbo.",
    ".obbbbbbmbbbbbo.",
  ],
};

const FACE_FOR: Record<PetState, keyof typeof FACES> = {
  idle: "open",
  happy: "happy",
  thirsty: "lookUp",
  hungry: "sad",
  veryHungry: "drained",
  recovering: "open",
  goal: "happy",
  sleeping: "sleep",
};

const FACE_ROW = 10;
// Rows 1..15 hold water; fill 0 leaves them all as empty glass.
const WATER_TOP = 1;
const WATER_BOTTOM = 15;

/** Rows of the grid for a state, eyes closed when `blink`, filled to `fill` (0..1). */
export function compose(state: PetState, fill: number, blink = false): string[] {
  const face = blink && state !== "sleeping" && state !== "veryHungry" ? FACES.blink : FACES[FACE_FOR[state]];
  const rows = BODY.map((r) => r);
  face.forEach((row, i) => (rows[FACE_ROW + i] = row));
  const f = Math.max(0, Math.min(1, Number.isFinite(fill) ? fill : 0));
  // The water line: rows above it are glass. Always keep the bottom row wet
  // so even an empty day shows a puddle (Byte is never bone dry).
  const waterRows = WATER_BOTTOM - WATER_TOP + 1;
  const line = WATER_BOTTOM - Math.max(1, Math.round(f * waterRows)) + 1;
  return rows.map((row, y) => {
    if (y >= line || y < WATER_TOP) return row;
    return row.replace(/[bls]/g, (ch) => (ch === "l" ? "l" : "g"));
  });
}

export interface Pixel {
  x: number;
  y: number;
  key: string;
}

export function pixels(rows: readonly string[]): Pixel[] {
  const out: Pixel[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const key = row[x];
      if (key !== ".") out.push({ x, y, key });
    }
  });
  return out;
}
