import { api, errorText } from "../api";
import { HELP_LINES, MAX_COMMAND_LENGTH, parseCommand } from "../core/commands";
import { LinePicker, moodSituation } from "../core/copy";
import { ago, clockAt, minutesToHHMM, prettyDay } from "../core/dates";
import { buildDays, gitLog, shortHash, streaks } from "../core/history";
import type { Snapshot } from "../core/types";
import { formatAmount, parseAmount, presets } from "../core/units";
import { clear, h, panel } from "./dom";
import { PetView } from "./pet";

export interface Ctx {
  snap: () => Snapshot;
  apply: (s: Snapshot) => void;
  say: (text: string, tone?: "ok" | "err" | "info") => void;
  motion: () => boolean;
  picker: LinePicker;
}

export function asciiBar(total: number, goal: number, width: number): string {
  const r = Math.max(0, Math.min(1, total / Math.max(goal, 1)));
  const full = Math.round(r * width);
  return `[${"#".repeat(full)}${"-".repeat(width - full)}]`;
}

function blockText(s: Snapshot): string {
  const r = s.reminders;
  const t = (ms: number) => clockAt(ms, s.offsetMin);
  switch (r.block) {
    case "disabled": return "reminders off";
    case "pausedToday": return "reminders paused for today";
    case "goalMet": return "no more reminders today";
    case "dailyMax": return "daily reminder limit reached";
    case "doneForToday": return "no reminders left today";
    case "beforeActive": return `active from ${minutesToHHMM(s.settings.activeStart)}`;
    case "snoozed": return r.snoozeUntil ? `snoozed until ${t(r.snoozeUntil)}` : "snoozed";
    case "quiet": return r.due ? `quiet hours · next ping ${t(r.due)}` : "quiet hours";
    default: return r.due ? `next ping ~${t(r.due)}` : "";
  }
}

export class TodayView {
  readonly el: HTMLElement;
  private pet = new PetView();
  // Not a live region: the toast already announces what happened.
  private mood = h("p", { class: "mood" });
  private moodKey = "";
  private meta = h("p", { class: "pet-meta" });
  private bar = h("div", { class: "bar", role: "progressbar", "aria-valuemin": 0 });
  private barText = h("p", { class: "bar-text" });
  private quick = h("div", { class: "quick" });
  private custom = h("input", { class: "field", id: "custom-amount", inputmode: "decimal", autocomplete: "off", maxlength: 8, "aria-describedby": "custom-hint" });
  private customHint = h("span", { class: "hint", id: "custom-hint", "aria-live": "polite" });
  private out = h("div", { class: "term-out", role: "log", "aria-live": "polite", "aria-label": "command output" });
  private cmd = h("input", { class: "cmd-input", id: "cmd", autocomplete: "off", spellcheck: "false", maxlength: MAX_COMMAND_LENGTH, "aria-label": "command, type help for a list" });
  private list = h("ol", { class: "today-log" });
  private undoBtn = h("button", { class: "btn ghost small", type: "button" }, "undo last");
  private lastTotal = -1;
  private listKey = "";

  constructor(private ctx: Ctx) {
    const customForm = h(
      "form",
      { class: "custom", onsubmit: (e: Event) => { e.preventDefault(); void this.logCustom(); } },
      h("label", { for: "custom-amount", class: "sr-only" }, "custom amount"),
      this.custom,
      h("button", { class: "btn", type: "submit" }, "log"),
    );
    const cmdForm = h(
      "form",
      { class: "cmd", onsubmit: (e: Event) => { e.preventDefault(); void this.run(); } },
      h("span", { class: "prompt", "aria-hidden": "true" }, "$"),
      this.cmd,
    );
    this.undoBtn.addEventListener("click", () => void this.undo());
    this.custom.addEventListener("input", () => this.custom.hasAttribute("aria-invalid") && this.resetHint());
    this.el = h(
      "div",
      { class: "view today", id: "view-today", role: "tabpanel", "aria-labelledby": "tab-today" },
      panel("pet.status", "pet-panel", h("div", { class: "pet-stage" }, this.pet.el), this.mood, this.meta),
      panel("hydration", "bar-panel", this.bar, this.barText, this.quick, customForm, this.customHint),
      panel("today.log", "log-panel", h("div", { class: "log-head" }, h("span", { class: "dim" }, "time   amount"), this.undoBtn), this.list),
      panel("shell", "cmd-panel", this.out, cmdForm),
    );
    this.echo(["type help for commands"], "dim");
  }

  focusCommand() {
    this.cmd.focus();
  }

  render() {
    const s = this.ctx.snap();
    const set = s.settings;
    const fill = s.todayTotal / Math.max(s.todayGoal, 1);
    this.pet.update(set.petName, s.hunger.pet, fill, this.ctx.motion());
    if (this.lastTotal >= 0 && s.todayTotal > this.lastTotal) this.pet.feed();
    this.lastTotal = s.todayTotal;

    // Mood line changes only when the situation does, so it doesn't flicker.
    const quiet = s.reminders.block === "quiet";
    const situation = moodSituation(s.hunger.pet, s.reminders.pausedToday, quiet);
    const key = `${situation}|${set.petName}|${set.chill}|${set.noJokes}|${set.unit}`;
    if (key !== this.moodKey && s.hunger.pet !== "happy") {
      this.moodKey = key;
      this.mood.textContent = this.ctx.picker.pick(set, situation);
    }

    const today = s.entries.filter((e) => e.date === s.today).sort((a, b) => a.ts - b.ts);
    const last = today[today.length - 1];
    const parts = [last ? `last drink ${ago(last.ts, s.now)}` : "nothing logged yet today", blockText(s)].filter(Boolean);
    this.meta.textContent = parts.join(" · ");

    const width = 24;
    this.bar.textContent = asciiBar(s.todayTotal, s.todayGoal, width);
    this.bar.setAttribute("aria-valuemax", String(s.todayGoal));
    this.bar.setAttribute("aria-valuenow", String(Math.min(s.todayTotal, s.todayGoal)));
    this.bar.setAttribute("aria-label", "today's water");
    this.bar.setAttribute("aria-valuetext", `${formatAmount(s.todayTotal, set.unit)} of ${formatAmount(s.todayGoal, set.unit)}`);
    this.bar.dataset.done = String(s.hunger.goalMet);
    const pct = Math.round((s.todayTotal / Math.max(s.todayGoal, 1)) * 100);
    clear(
      this.barText,
      h("strong", {}, formatAmount(s.todayTotal, set.unit)),
      ` / ${formatAmount(s.todayGoal, set.unit)}  `,
      h("span", { class: s.hunger.goalMet ? "good" : "dim" }, s.hunger.goalMet ? "goal complete" : `${pct}%`),
    );

    const unitKey = set.unit;
    if (this.quick.dataset.unit !== unitKey) {
      this.quick.dataset.unit = unitKey;
      clear(
        this.quick,
        ...presets(set.unit).map((ml) => h("button", { class: "btn add", type: "button", "data-ml": ml, "aria-label": `log ${formatAmount(ml, set.unit)}`, onclick: () => void this.log(ml) }, `+${formatAmount(ml, set.unit)}`)),
      );
      this.custom.placeholder = set.unit === "ml" ? "mL" : "oz";
      this.customHint.textContent = set.unit === "ml" ? "1-2000 mL per drink" : "up to 67 oz per drink";
    }

    // Rebuild rows only when they change, so a focused "del" keeps focus.
    const rows = JSON.stringify([set.unit, today.map((e) => e.id)]);
    if (rows !== this.listKey) {
      this.listKey = rows;
      this.renderList(today, set.unit);
    }
    this.undoBtn.disabled = s.entries.length === 0;
  }

  private renderList(today: Snapshot["entries"], unit: Snapshot["settings"]["unit"]) {
    const set = { unit };
    const hadFocus = this.list.contains(document.activeElement);
    clear(this.list);
    if (today.length === 0) {
      this.list.append(h("li", { class: "empty" }, "no commits yet today. one sip starts the log."));
    }
    for (const e of today.slice().reverse()) {
      this.list.append(
        h(
          "li",
          {},
          h("span", { class: "time" }, clockAt(e.ts, e.offsetMin)),
          h("span", { class: "amt" }, `+${formatAmount(e.ml, set.unit)}`),
          h("button", { class: "btn ghost small del", type: "button", "aria-label": `delete ${formatAmount(e.ml, set.unit)} at ${clockAt(e.ts, e.offsetMin)}`, onclick: () => void this.remove(e.id) }, "del"),
        ),
      );
    }
    // A deleted row took focus with it: land on the next row's button, or undo.
    if (hadFocus) ((this.list.querySelector(".del") as HTMLElement | null) ?? this.undoBtn).focus();
  }

  private async log(ml: number) {
    const before = this.ctx.snap().hunger;
    try {
      const s = await api.log(ml);
      this.ctx.apply(s);
      const kind = s.hunger.goalMet && !before.goalMet ? "goal" : before.stage === "hungry" || before.stage === "veryHungry" ? "recovered" : "log";
      const line = this.ctx.picker.pick(s.settings, kind, ml);
      this.mood.textContent = line;
      this.moodKey = "";
      this.ctx.say(line, "ok");
    } catch (e) {
      this.ctx.say(`not saved: ${errorText(e)}`, "err");
    }
  }

  private async logCustom() {
    const r = parseAmount(this.custom.value, this.ctx.snap().settings.unit);
    if (!r.ok) {
      this.customHint.textContent = r.error;
      this.customHint.classList.add("err");
      this.custom.setAttribute("aria-invalid", "true");
      return;
    }
    this.custom.value = "";
    this.resetHint();
    await this.log(r.ml);
  }

  private resetHint() {
    this.custom.removeAttribute("aria-invalid");
    this.customHint.classList.remove("err");
    this.customHint.textContent = this.ctx.snap().settings.unit === "ml" ? "1-2000 mL per drink" : "up to 67 oz per drink";
  }

  private async undo() {
    try {
      this.ctx.apply(await api.undo());
      this.ctx.say("reverted the last commit.", "info");
    } catch (e) {
      this.ctx.say(`not saved: ${errorText(e)}`, "err");
    }
  }

  private async remove(id: string) {
    try {
      this.ctx.apply(await api.remove(id));
      this.ctx.say("entry deleted.", "info");
    } catch (e) {
      this.ctx.say(`not saved: ${errorText(e)}`, "err");
    }
  }

  private echo(lines: string[], cls = "") {
    for (const l of lines) this.out.append(h("div", { class: `line ${cls}` }, l));
    while (this.out.childElementCount > 60) this.out.firstElementChild?.remove();
    this.out.scrollTop = this.out.scrollHeight;
  }

  private async run() {
    const raw = this.cmd.value;
    this.cmd.value = "";
    if (!raw.trim()) return;
    this.echo([`$ ${raw.slice(0, MAX_COMMAND_LENGTH)}`], "echo");
    const s = this.ctx.snap();
    const c = parseCommand(raw, s.settings.unit);
    const u = s.settings.unit;
    switch (c.kind) {
      case "drink":
      {
        const before = s.entries.length;
        await this.log(c.ml);
        const after = this.ctx.snap().entries;
        const newest = after.length > before ? after.reduce((a, b) => (b.ts > a.ts ? b : a)) : null;
        this.echo([newest ? `[main ${shortHash(newest.id)}] +${formatAmount(c.ml, u)} committed` : "nothing committed"], newest ? "" : "err");
        break;
      }
      case "status": {
        const d = buildDays(s.entries, s.dayGoals, s.settings.goalMl, s.today);
        const st = streaks(d);
        this.echo([
          `on branch main · ${prettyDay(s.today)}`,
          `${asciiBar(s.todayTotal, s.todayGoal, 20)} ${formatAmount(s.todayTotal, u)} / ${formatAmount(s.todayGoal, u)}`,
          `${s.settings.petName}: ${s.hunger.pet === "veryHungry" ? "very hungry" : s.hunger.pet} · streak ${st.current}d`,
          blockText(s) || "reminders idle",
        ]);
        break;
      }
      case "log": {
        const d = buildDays(s.entries, s.dayGoals, s.settings.goalMl, s.today);
        const lines = gitLog(d, u, { oneline: c.oneline, limitDays: c.oneline ? 3 : 1 })
          .map((l) => (l.kind === "commit" ? `${c.oneline ? "" : "* "}${l.hash} ${c.oneline ? "" : l.time + "  "}${l.text}` : l.kind === "header" ? l.text : l.text ? `| ${l.text}` : "|"));
        this.echo(lines.length ? lines.slice(0, 24) : ["nothing to show"]);
        break;
      }
      case "streak": {
        const st = streaks(buildDays(s.entries, s.dayGoals, s.settings.goalMl, s.today));
        this.echo([`current streak: ${st.current} day${st.current === 1 ? "" : "s"}${st.todayCounts ? " (today counted)" : ""}`, `best streak: ${st.best} day${st.best === 1 ? "" : "s"}`]);
        break;
      }
      case "error":
        this.echo([c.message], "err");
        break;
      default:
        this.echo(HELP_LINES, "dim");
    }
  }
}
