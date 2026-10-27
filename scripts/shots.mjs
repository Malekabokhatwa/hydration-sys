// Headless screenshots of the mock build (npm run build:mock first).
// Usage: node scripts/shots.mjs <outDir> [scenario...]
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "screenshots";
const scenarios = process.argv.slice(3).length ? process.argv.slice(3) : ["today", "hungry", "veryHungry", "goal", "fresh", "history"];
mkdirSync(out, { recursive: true });
const server = await createServer({ mode: "mock", server: { port: 1421, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
const at = "2026-10-27T15:10:00";
for (const sc of scenarios) {
  for (const [w, hgt, scale, tag] of [[440, 700, 1, ""], [360, 560, 1, "-min"], [440, 700, 1.5, "-150"]]) {
    if (tag && !["today", "history"].includes(sc)) continue;
    const page = await browser.newPage({ viewport: { width: w, height: hgt }, deviceScaleFactor: scale, reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:1421/?scenario=${sc}&now=${at}`);
    await page.waitForSelector(".pet rect");
    if (sc === "history") await page.click("#tab-history");
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${out}/${sc}${tag}.png` });
    await page.close();
  }
}
await browser.close();
await server.close();
console.log("done");
