// README screenshots of the mock build at 2x, in the Nord Omarchy theme.
// Run: node scripts/readme-shots.mjs  (writes docs/screens/*.png)
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { mkdirSync } from "node:fs";

const out = "docs/screens";
mkdirSync(out, { recursive: true });
const server = await createServer({ mode: "mock", server: { port: 1437, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
const at = "2026-10-27T15:10:00";

// [file, scenario, steps before the shot]
const shots = [
  ["today", "history", async () => {}],
  ["very-hungry", "veryHungry", async () => {}],
  ["log", "history", async (p) => p.click("#tab-history")],
  ["graph", "history", async (p) => { await p.click("#tab-history"); await p.click('[data-mode="graph"]'); }],
  ["config", "today", async (p) => p.click("#tab-settings")],
  ["setup", "fresh", async () => {}],
];

for (const [name, scenario, steps] of shots) {
  const page = await browser.newPage({ viewport: { width: 440, height: 700 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:1437/?scenario=${scenario}&now=${at}`);
  await page.waitForSelector(".pet rect");
  await steps(page);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.close();
}
await browser.close();
await server.close();
console.log("written to", out);
