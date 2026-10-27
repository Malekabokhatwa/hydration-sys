import "./styles.css";
import { api, connect, errorText } from "./api";
import { LinePicker } from "./core/copy";
import { clockAt, prettyDay } from "./core/dates";
import { buildDays, streaks } from "./core/history";
import type { Snapshot } from "./core/types";
import { clear, h } from "./ui/dom";
import { HistoryView } from "./ui/history";
import { Onboarding } from "./ui/onboarding";
import { SettingsView } from "./ui/settings";
import { applyTheme } from "./ui/theme";
import { TodayView, type Ctx } from "./ui/today";

type Tab = "today" | "history" | "settings";
const TABS: [Tab, string][] = [["today", "today"], ["history", "log"], ["settings", "config"]];

const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

class Shell {
  private snap!: Snapshot;
  private tab: Tab = "today";
  private ctx: Ctx;
  private today: TodayView;
  private history: HistoryView;
  private settings: SettingsView;
  private headerDate = h("span", { class: "hdr-date" });
  private headerStreak = h("span", { class: "hdr-streak" });
  private tabBar = h("nav", { class: "tabs", role: "tablist", "aria-label": "sections" });
  private toast = h("div", { class: "toast", role: "status", "aria-live": "polite", title: "click to dismiss" });
  private statusLine = h("footer", { class: "statusline" });
  private notice = h("div", { class: "notice-slot" });
  private toastTimer = 0;
  private onboarding: Onboarding | null = null;

  constructor(private root: HTMLElement) {
    this.ctx = {
      snap: () => this.snap,
      apply: (s) => this.apply(s),
      say: (t, tone) => this.say(t, tone),
      motion: () => this.motion(),
      picker: new LinePicker(),
    };
    this.today = new TodayView(this.ctx);
    this.history = new HistoryView(this.ctx);
    this.settings = new SettingsView(this.ctx);
    TABS.forEach(([id, label], i) => {
      this.tabBar.append(
        h("button", { class: "tab", id: `tab-${id}`, role: "tab", type: "button", "aria-controls": `view-${id}`, "data-tab": id, "aria-keyshortcuts": `Alt+${i + 1} ${i + 1}`, title: `${label} (${i + 1} or alt+${i + 1})`, onclick: () => this.show(id) },
          h("span", { class: "tab-key", "aria-hidden": "true" }, String(i + 1)), label),
      );
    });
    this.tabBar.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = TABS.findIndex(([t]) => t === this.tab);
      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length][0];
      this.show(next);
      document.getElementById(`tab-${next}`)?.focus();
    });
    const header = h(
      "header",
      { class: "hdr" },
      h("div", { class: "brand" }, h("span", { class: "brand-name" }, "hydration.sys"), h("span", { class: "cursor", "aria-hidden": "true" }, "█")),
      h("div", { class: "hdr-meta" }, this.headerDate, this.headerStreak),
    );
    const main = h("main", { class: "views" }, this.notice, this.today.el, this.history.el, this.settings.el);
    clear(root, header, this.tabBar, main, this.statusLine, this.toast);
    document.addEventListener("keydown", (e) => this.keys(e));
    reducedQuery.addEventListener("change", () => this.render());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void api.snapshot().then((s) => this.apply(s));
    });
    // Relative times ("12m ago") refresh while visible; the native side
    // pushes real state changes on its own.
    window.setInterval(() => {
      if (document.visibilityState === "visible" && this.snap) this.render();
    }, 30_000);
  }

  motion(): boolean {
    const m = this.snap?.settings.motion ?? "system";
    return m === "full" || (m === "system" && !reducedQuery.matches);
  }

  apply(s: Snapshot) {
    if (this.snap && s.seq < this.snap.seq) return; // arrived out of order
    const first = !this.snap;
    this.snap = s;
    if (first) this.firstRun();
    this.render();
  }

  private firstRun() {
    if (!this.snap.settings.onboarded) this.startOnboarding();
  }

  private startOnboarding() {
    // The rest of the app is inert while setup runs, so Tab can't wander behind it.
    const shell = Array.from(this.root.children) as HTMLElement[];
    shell.forEach((el) => (el.inert = true));
    this.onboarding = new Onboarding(this.ctx, () => {
      this.onboarding?.el.remove();
      this.onboarding = null;
      shell.forEach((el) => (el.inert = false));
      this.render();
      this.today.focusCommand();
    });
    this.root.append(this.onboarding.el);
    this.onboarding.focusFirst();
  }

  render() {
    const s = this.snap;
    const html = document.documentElement;
    applyTheme(s);
    html.dataset.motion = this.motion() ? "full" : "reduce";
    html.dataset.chill = String(s.settings.chill || s.settings.noJokes);
    html.dataset.os = s.platform.os;
    if (!s.settings.onboarded && !this.onboarding) this.startOnboarding();

    this.headerDate.textContent = prettyDay(s.today);
    const st = streaks(buildDays(s.entries, s.dayGoals, s.settings.goalMl, s.today));
    this.headerStreak.textContent = `streak ${st.current}d`;
    this.headerStreak.title = `best streak ${st.best} days`;

    this.tabBar.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
      const on = b.dataset.tab === this.tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    this.today.el.hidden = this.tab !== "today";
    this.history.el.hidden = this.tab !== "history";
    this.settings.el.hidden = this.tab !== "settings";
    if (this.tab === "today") this.today.render();
    if (this.tab === "history") this.history.render();
    if (this.tab === "settings") this.settings.render();
    this.renderNotice();
    this.renderStatus();
  }

  private renderNotice() {
    const s = this.snap;
    const n = s.storage.notice;
    const items: HTMLElement[] = [];
    if (n) {
      const head = n.kind === "repaired"
        ? `${n.dropped} invalid item${n.dropped === 1 ? " was" : "s were"} skipped while loading your data.`
        : n.kind === "recoveredFromBackup" ? "data file was damaged. restored the previous backup." : "data file was damaged and no usable backup existed. started fresh.";
      const tail = n.kind === "repaired" ? ` everything else loaded. the original file is kept at ${n.kept}.` : ` (${n.reason}). the damaged copy is kept at ${n.kept}.`;
      items.push(
        h("div", { class: "notice err", role: "alert" },
          h("strong", {}, head),
          h("span", {}, tail),
          h("button", { class: "btn ghost small", type: "button", onclick: () => void api.dismissNotice().then((x) => this.apply(x)) }, "ok")),
      );
    }
    if (!s.storage.lastSaveOk) {
      items.push(h("div", { class: "notice err", role: "alert" }, h("strong", {}, "not saved. "), s.storage.lastError ?? ""));
    }
    if (this.notice.dataset.key !== JSON.stringify([n, s.storage.lastSaveOk, s.storage.lastError])) {
      this.notice.dataset.key = JSON.stringify([n, s.storage.lastSaveOk, s.storage.lastError]);
      clear(this.notice, ...items);
    }
  }

  private renderStatus() {
    const s = this.snap;
    const r = s.reminders;
    const t = (ms: number) => clockAt(ms, s.offsetMin);
    const rem = !s.settings.remindersEnabled ? "reminders off" : r.pausedToday ? "paused today" : r.snoozeUntil ? `snoozed → ${t(r.snoozeUntil)}` : r.due ? `next ~${t(r.due)}` : r.block === "goalMet" ? "done for today" : "idle";
    const hunger = { fed: "fed", peckish: "peckish", hungry: "hungry", veryHungry: "very hungry" }[s.hunger.stage];
    clear(
      this.statusLine,
      h("span", { class: `sl-seg ${s.storage.lastSaveOk ? "ok" : "bad"}`, title: s.storage.lastSaveOk ? "all changes saved" : "not saved" }, s.storage.lastSaveOk ? "● saved" : "● unsaved"),
      h("span", { class: "sl-seg" }, rem),
      h("span", { class: "sl-seg" }, `${s.settings.petName}: ${hunger}`),
      h("span", { class: "sl-seg right dim" }, "local only"),
    );
  }

  show(tab: Tab) {
    this.tab = tab;
    this.render();
  }

  say(text: string, tone: "ok" | "err" | "info" = "info") {
    this.toast.textContent = text;
    this.toast.dataset.tone = tone;
    this.toast.classList.add("on");
    this.toast.onclick = () => this.toast.classList.remove("on");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove("on"), tone === "err" ? 7000 : 3200);
  }

  private keys(e: KeyboardEvent) {
    if (this.onboarding) return;
    const t = e.target as HTMLElement;
    const typing = t.matches("input, select, textarea");
    if (["1", "2", "3"].includes(e.key) && (e.altKey || (!typing && !e.ctrlKey && !e.metaKey))) {
      this.show(TABS[Number(e.key) - 1][0]);
      document.getElementById(`tab-${TABS[Number(e.key) - 1][0]}`)?.focus();
      e.preventDefault();
    } else if (!typing && e.key === "/") {
      this.show("today");
      this.today.focusCommand();
      e.preventDefault();
    } else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      void api.undo().then((s) => this.apply(s), (err) => this.say(errorText(err), "err"));
      e.preventDefault();
    }
  }
}

/** Under 800 ms, skippable, never on autostart or with reduced motion. */
function boot(root: HTMLElement, s: Snapshot, motion: boolean): Promise<void> {
  if (!s.platform.bootEligible || !motion || s.platform.autostarted) return Promise.resolve();
  const lines = [
    "[ ok ] mounting /dev/water",
    "[ ok ] starting hydration.service",
    `[ ok ] waking ${s.settings.petName.trim()}.exe`,
    "hydration.sys ready_",
  ];
  const term = h("div", { class: "boot-lines" });
  const el = h("div", { class: "boot", "aria-hidden": "true" }, term, h("span", { class: "boot-skip" }, "any key to skip"));
  root.append(el);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.classList.add("out");
      window.setTimeout(() => el.remove(), 140);
      window.removeEventListener("keydown", finish);
      el.removeEventListener("pointerdown", finish);
      void api.bootShown().catch(() => {});
      resolve();
    };
    window.addEventListener("keydown", finish);
    el.addEventListener("pointerdown", finish);
    lines.forEach((l, i) => window.setTimeout(() => !done && term.append(h("div", {}, l)), 90 + i * 140));
    window.setTimeout(finish, 760);
  });
}

async function start() {
  const root = document.getElementById("app")!;
  try {
    const backend = await connect();
    const shell = new Shell(root);
    const s = await api.snapshot();
    backend.onSnapshot((x) => shell.apply(x));
    backend.onNavigate((tab) => (tab === "settings" || tab === "history" || tab === "today") && shell.show(tab));
    shell.apply(s);
    const m = s.settings.motion;
    await boot(root, s, m === "full" || (m === "system" && !reducedQuery.matches));
  } catch (e) {
    clear(root, h("pre", { class: "fatal" }, `hydration.sys could not start its interface:\n${errorText(e)}`));
  }
}

void start();
