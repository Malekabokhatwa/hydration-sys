// Renders Byte's sprite grid into the app icon, tray icons and Windows .ico.
// Requires ImageMagick 7 (`magick`). Run: npm run icons
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compose, pixels, WIDTH, HEIGHT } from "../src/core/sprite.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "icons");
const work = join(tmpdir(), `hydration-icons-${process.pid}`);
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

const WATER = { o: "#0b1210", b: "#5ec8f2", l: "#d4f4ff", s: "#3593bd", e: "#0b1210", w: "#ffffff", c: "#ff9f9f", m: "#0b1210", g: "#41565e" };
const HUNGRY = { ...WATER, b: "#c9b06a", l: "#f4e6b8", s: "#9a8344" };
// Monochrome silhouette: white body, face punched out.
const MONO = Object.fromEntries(Object.keys(WATER).map((k) => [k, ["e", "m", "w"].includes(k) ? "none" : "#ffffff"]));

function spriteRects(rows, palette, ox, oy, px) {
  return pixels(rows)
    .filter((p) => palette[p.key] && palette[p.key] !== "none")
    .map((p) => `<rect x="${ox + p.x * px}" y="${oy + p.y * px}" width="${px}" height="${px}" fill="${palette[p.key]}"/>`)
    .join("");
}

function svg(size, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${body}</svg>`;
}

// App icon: Byte inside a small terminal tile with a prompt line.
function appIcon() {
  const S = 512;
  const px = 20;
  const ox = Math.round((S - WIDTH * px) / 2);
  const oy = 104;
  const rows = compose("happy", 0.7);
  const tile = `<rect x="16" y="16" width="480" height="480" rx="72" fill="#101410"/>` +
    `<rect x="16" y="16" width="480" height="480" rx="72" fill="none" stroke="#2c3b2c" stroke-width="8"/>` +
    `<rect x="40" y="40" width="432" height="36" rx="10" fill="#192019"/>` +
    `<rect x="60" y="52" width="12" height="12" fill="#ff9f9f"/><rect x="82" y="52" width="12" height="12" fill="#f6c66d"/><rect x="104" y="52" width="12" height="12" fill="#b4f58a"/>`;
  return svg(S, tile + spriteRects(rows, WATER, ox, oy, px));
}

// Tray hosts scale the whole canvas to ~16-22 px, so keep padding minimal.
function trayIcon(state, fill, palette) {
  const S = 56;
  const px = 3;
  const ox = Math.round((S - WIDTH * px) / 2);
  const oy = Math.round((S - HEIGHT * px) / 2);
  return svg(S, spriteRects(compose(state, fill), palette, ox, oy, px));
}

function render(name, content, size) {
  const src = join(work, `${name}.svg`);
  writeFileSync(src, content);
  const dest = join(out, `${name}.png`);
  execFileSync("magick", ["-background", "none", "-density", "96", src, "-resize", `${size}x${size}`, "-strip", `PNG32:${dest}`]);
  return dest;
}

const master = render("icon", appIcon(), 512);
// Vector copy for the README.
mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "docs", "icon.svg"), appIcon());
for (const [name, size] of [["32x32", 32], ["64x64", 64], ["128x128", 128], ["128x128@2x", 256]]) {
  execFileSync("magick", [master, "-filter", "point", "-resize", `${size}x${size}`, "-strip", `PNG32:${join(out, `${name}.png`)}`]);
}
execFileSync("magick", [master, "-define", "icon:auto-resize=256,64,48,32,24,16", join(out, "icon.ico")]);

render("tray-fed", trayIcon("idle", 0.75, WATER), 56);
render("tray-thirsty", trayIcon("thirsty", 0.4, WATER), 56);
render("tray-hungry", trayIcon("hungry", 0.15, HUNGRY), 56);
render("tray-goal", trayIcon("goal", 1, WATER), 56);
render("tray-mono", trayIcon("idle", 1, MONO), 56);

rmSync(work, { recursive: true, force: true });
console.log("icons written to", out);
