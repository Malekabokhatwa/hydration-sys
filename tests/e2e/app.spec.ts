import { expect, test, type Page } from "@playwright/test";

const AT = "2026-10-27T15:10:00";
const open = async (page: Page, q = "scenario=today") => {
  await page.goto(`/?${q}&now=${AT}`);
  await page.waitForSelector(".pet rect");
};

test.beforeEach(async ({ page }) => {
  const external: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith("http://127.0.0.1:1421")) external.push(r.url()); });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  (page as unknown as { checks: () => void }).checks = () => {
    expect(external, "no requests leave the app").toEqual([]);
    expect(errors, "no console errors").toEqual([]);
  };
});
test.afterEach(async ({ page }) => (page as unknown as { checks: () => void }).checks());

test("quick add logs water and updates bar, log and pet", async ({ page }) => {
  await open(page);
  await expect(page.locator(".bar-text")).toContainText("900 mL / 2,000 mL");
  await page.getByRole("button", { name: "log 250 mL" }).click();
  await expect(page.locator(".bar-text")).toContainText("1,150 mL");
  await expect(page.locator(".today-log li")).toHaveCount(4);
  await expect(page.locator(".pet")).toHaveAttribute("data-state", "happy");
  await expect(page.locator(".pet")).toHaveAttribute("aria-label", /byte .*water level 57 percent/);
  await page.getByRole("button", { name: "undo last" }).click();
  await expect(page.locator(".bar-text")).toContainText("900 mL");
});

test("custom amount is validated", async ({ page }) => {
  await open(page);
  const input = page.locator("#custom-amount");
  for (const bad of ["0", "3000", "abc", "12.5"]) {
    await input.fill(bad);
    await input.press("Enter");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#custom-hint")).toHaveClass(/err/);
  }
  await input.fill("8oz");
  await input.press("Enter");
  await expect(page.locator(".bar-text")).toContainText("1,137 mL");
});

test("command bar only runs whitelisted commands", async ({ page }) => {
  await open(page);
  const cmd = page.locator("#cmd");
  await cmd.fill("drink 250");
  await cmd.press("Enter");
  await expect(page.locator(".term-out")).toContainText("+250 mL committed");
  await cmd.fill("hydration log --oneline");
  await cmd.press("Enter");
  await expect(page.locator(".term-out")).toContainText("feat: +250 mL");
  await cmd.fill("status");
  await cmd.press("Enter");
  await expect(page.locator(".term-out")).toContainText("on branch main");
  await cmd.fill("rm -rf / <img src=x onerror=alert(1)>");
  await cmd.press("Enter");
  await expect(page.locator(".term-out")).toContainText("drink <amount>");
  await expect(page.locator(".term-out img")).toHaveCount(0);
});

test("stored text is never injected as HTML", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Alt+3");
  const name = page.locator("input[name=petName]");
  await name.fill("<b>x</b>");
  await name.dispatchEvent("change");
  await page.keyboard.press("Alt+1");
  await expect(page.locator(".statusline")).toContainText("<b>x</b>:");
  await expect(page.locator("b")).toHaveCount(0);
});

test("history: git log, heatmap keyboard navigation, tags", async ({ page }) => {
  await open(page, "scenario=history");
  await page.keyboard.press("Alt+2");
  await expect(page.locator(".gl-commit").first()).toContainText("(HEAD -> main)");
  await expect(page.locator(".gl-head").first()).toContainText("commit-date");
  await page.getByRole("radio", { name: "graph" }).click();
  const focused = page.locator(".cell[tabindex='0']");
  await focused.focus();
  const before = await focused.getAttribute("aria-label");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".cell[tabindex='0']")).not.toHaveAttribute("aria-label", before ?? "");
  await expect(page.locator(".diff-line.meta")).toContainText("diff --hydration");
  await expect(page.locator(".cell.l4").first()).toHaveText("█");
  await page.getByRole("radio", { name: "tags" }).click();
  await expect(page.locator(".tags")).toContainText("v1.0");
});

test("goal change applies tomorrow", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Alt+3");
  const goal = page.locator("input[name=goal]");
  await goal.fill("2500");
  await goal.dispatchEvent("change");
  await expect(page.getByText("starts tomorrow")).toBeVisible();
  await page.keyboard.press("Alt+1");
  await expect(page.locator(".bar-text")).toContainText("/ 2,000 mL");
});

test("close-to-tray needs a confirmed tray", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Alt+3");
  await expect(page.locator("input[name=closeToTray]")).toBeDisabled();
  await page.getByRole("button", { name: "I can see it" }).click();
  await expect(page.locator("input[name=closeToTray]")).toBeEnabled();
});

test("first run onboarding has working not-now paths", async ({ page }) => {
  await open(page, "scenario=fresh");
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("byte.exe installed.");
  await expect(page.locator("#ob-name")).toBeFocused();
  await expect(page.locator("#tab-today")).not.toBeFocused();
  await page.locator("#ob-name").fill("Pixel");
  await page.keyboard.press("Enter"); // Enter submits the step
  await expect(dlg).toContainText("not medical advice");
  await dlg.getByRole("button", { name: "next" }).click();
  await dlg.getByRole("button", { name: "not now" }).click();
  await dlg.getByRole("button", { name: "no", exact: true }).click();
  await expect(page.locator("#ob-autostart")).not.toBeChecked();
  await dlg.getByRole("button", { name: "finish" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(".statusline")).toContainText("reminders off");
  await expect(page.locator(".statusline")).toContainText("Pixel:");
});

test("reduced motion and chill disable effects", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  const anim = await page.locator(".cursor").evaluate((e) => getComputedStyle(e).animationName);
  expect(anim).toBe("none");
});

test("boot sequence is skippable and short", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`/?scenario=today&now=${AT}&boot=1`);
  await expect(page.locator(".boot")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.locator(".boot")).toHaveCount(0, { timeout: 1000 });
});

test("load notice is shown", async ({ page }) => {
  await open(page, "scenario=today&notice=1");
  await expect(page.getByRole("alert")).toContainText("restored the previous backup");
});

for (const [w, h, s, name] of [[440, 700, 1, "default"], [360, 560, 1, "min"], [440, 700, 1.5, "150"]] as const) {
  test(`no clipping at ${name} size`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: s, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    for (const tab of ["1", "2", "3"]) {
      await page.goto(`/?scenario=history&now=${AT}`);
      await page.waitForSelector(".pet rect");
      await page.keyboard.press(`Alt+${tab}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/shots/${name}-tab${tab}.png` });
    }
    await ctx.close();
  });
}
