import { api, errorText } from "../api";
import { clockAt, hhmmToMinutes, minutesToHHMM } from "../core/dates";
import type { Settings, Snapshot } from "../core/types";
import { formatAmount, mlToOz, ozToMl } from "../core/units";
import { clear, h, panel } from "./dom";
import { palette } from "./theme";
import type { Ctx } from "./today";

type Field = HTMLInputElement | HTMLSelectElement;

let uid = 0;
function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || `f${++uid}`;
  control.id = id;
  const hintEl = hint ? h("span", { class: "hint", id: `${id}-hint` }, hint) : null;
  if (hintEl) control.setAttribute("aria-describedby", hintEl.id);
  return h("div", { class: "row" }, h("label", { for: id }, label), control, hintEl);
}

function toggle(name: string): HTMLInputElement {
  return h("input", { type: "checkbox", class: "switch", name, role: "switch" });
}

function num(name: string, min: number, max: number, step = 1): HTMLInputElement {
  return h("input", { type: "number", class: "field num", name, min, max, step, inputmode: "numeric" });
}

function time(name: string): HTMLInputElement {
  return h("input", { type: "time", class: "field time", name, step: 300 });
}

function select(name: string, options: [string, string][]): HTMLSelectElement {
  return h("select", { class: "field", name }, ...options.map(([v, l]) => h("option", { value: v }, l)));
}

export class SettingsView {
  readonly el: HTMLElement;
  private form: HTMLFormElement;
  private f: Record<string, Field> = {};
  private status = h("dl", { class: "status-list" });
  private trayBox = h("div", { class: "tray-box" });
  private startupBox = h("div", { class: "startup-box" });
  private dataBox = h("div", { class: "data-box" });
  private notifyResult = h("p", { class: "hint", "aria-live": "polite" });
  private goalHint = h("span", { class: "hint" });
  private goalNote = h("p", { class: "note" });
  private trayHint = h("span", { class: "hint" });
  private filling = false;
  /** Last inputs per box; a box is rebuilt only when they change, so the
   *  minute tick never steals keyboard focus from a button inside it. */
  private keys: Record<string, string> = {};

  constructor(private ctx: Ctx) {
    const f = this.f;
    f.petName = h("input", { class: "field", name: "petName", maxlength: 24, autocomplete: "off" });
    f.theme = select("theme", [["omarchy", "omarchy (follow system theme)"], ["phosphor", "phosphor green"], ["amber", "amber"]]);
    f.motion = select("motion", [["system", "follow system"], ["reduce", "reduced"], ["full", "full"]]);
    f.chill = toggle("chill");
    f.noJokes = toggle("noJokes");
    f.goal = num("goal", 250, 10000, 50);
    f.unit = select("unit", [["ml", "mL"], ["oz", "fl oz (US)"]]);
    f.activeStart = time("activeStart");
    f.activeEnd = time("activeEnd");
    f.remindersEnabled = toggle("remindersEnabled");
    f.interval = num("interval", 15, 480, 5);
    f.minGap = num("minGap", 10, 480, 5);
    f.dailyMax = num("dailyMax", 1, 24);
    f.quietEnabled = toggle("quietEnabled");
    f.quietStart = time("quietStart");
    f.quietEnd = time("quietEnd");
    f.peckish = num("peckish", 15, 720, 5);
    f.hungry = num("hungry", 15, 720, 5);
    f.veryHungry = num("veryHungry", 15, 720, 5);
    f.closeToTray = toggle("closeToTray");

    this.form = h(
      "form",
      { class: "settings-form", onsubmit: (e: Event) => e.preventDefault(), onchange: () => void this.save() },
      panel(
        "pet.cfg",
        "",
        row("pet name", f.petName),
        row("theme", f.theme),
        row("motion", f.motion, "reduced removes blinking, glitches and the boot animation"),
        row("chill mode", f.chill, "plain, minimal copy and no scanlines"),
        row("no jokes", f.noJokes, "neutral wording for work"),
      ),
      panel(
        "goal.cfg",
        "",
        row("daily goal", f.goal),
        this.goalHint,
        row("unit", f.unit),
        this.goalNote,
      ),
      panel(
        "schedule.cfg",
        "",
        h("div", { class: "pair" }, row("active from", f.activeStart), row("until", f.activeEnd)),
        h("p", { class: "hint" }, "hunger and reminders only run inside active hours, never overnight."),
        row("reminders", f.remindersEnabled),
        row("remind every (min)", f.interval, "counted from your last drink or reminder"),
        row("minimum gap (min)", f.minGap),
        row("max per day", f.dailyMax),
        row("quiet hours", f.quietEnabled, "reminders stay silent; logging still works"),
        h("div", { class: "pair" }, row("quiet from", f.quietStart), row("until", f.quietEnd)),
      ),
      panel(
        "hunger.cfg",
        "",
        h("p", { class: "hint" }, "minutes without a drink, inside active hours, before your pet gets:"),
        h("div", { class: "triple" }, row("peckish", f.peckish), row("hungry", f.hungry), row("very hungry", f.veryHungry)),
      ),
    );

    const testBtn = h("button", { class: "btn", type: "button", onclick: () => void this.testNotify() }, "send test notification");
    this.el = h(
      "div",
      { class: "view settings", id: "view-settings", role: "tabpanel", "aria-labelledby": "tab-settings", hidden: true },
      panel("system.status", "", this.status, h("div", { class: "btn-row" }, testBtn), this.notifyResult),
      panel("tray.cfg", "", this.trayBox, row("close to tray", f.closeToTray), this.trayHint),
      panel("startup.cfg", "", this.startupBox),
      this.form,
      panel("data", "", this.dataBox),
    );
    // closeToTray lives outside the form element, save it on its own.
    f.closeToTray.addEventListener("change", () => void this.save());
  }

  private fill(s: Settings) {
    this.filling = true;
    const f = this.f;
    const set = (k: string, v: string | boolean) => {
      const el = f[k];
      if (el === document.activeElement && el instanceof HTMLInputElement && el.type !== "checkbox") return;
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = v as boolean;
      else el.value = String(v);
    };
    set("petName", s.petName);
    set("theme", s.theme);
    set("motion", s.motion);
    set("chill", s.chill);
    set("noJokes", s.noJokes);
    set("unit", s.unit);
    set("goal", s.unit === "ml" ? String(s.goalMl) : mlToOz(s.goalMl).toFixed(0));
    (f.goal as HTMLInputElement).step = s.unit === "ml" ? "50" : "1";
    (f.goal as HTMLInputElement).min = s.unit === "ml" ? "250" : "9";
    (f.goal as HTMLInputElement).max = s.unit === "ml" ? "10000" : "338";
    set("activeStart", minutesToHHMM(s.activeStart));
    set("activeEnd", minutesToHHMM(s.activeEnd === 1440 ? 1439 : s.activeEnd));
    set("remindersEnabled", s.remindersEnabled);
    set("interval", String(s.reminderIntervalMin));
    set("minGap", String(s.minGapMin));
    set("dailyMax", String(s.dailyMax));
    set("quietEnabled", s.quietEnabled);
    set("quietStart", minutesToHHMM(s.quietStart));
    set("quietEnd", minutesToHHMM(s.quietEnd === 1440 ? 1439 : s.quietEnd));
    set("peckish", String(s.peckishMin));
    set("hungry", String(s.hungryMin));
    set("veryHungry", String(s.veryHungryMin));
    set("closeToTray", s.closeToTray);
    (f.closeToTray as HTMLInputElement).disabled = !s.trayVerified;
    for (const k of ["interval", "minGap", "dailyMax"]) f[k].toggleAttribute("disabled", !s.remindersEnabled);
    for (const k of ["quietStart", "quietEnd"]) f[k].toggleAttribute("disabled", !s.quietEnabled);
    this.filling = false;
  }

  private read(): Settings | string {
    const s = this.ctx.snap().settings;
    const f = this.f;
    const v = (k: string) => f[k].value;
    const c = (k: string) => (f[k] as HTMLInputElement).checked;
    const n = (k: string) => Number(v(k));
    const t = (k: string, end = false) => {
      const m = hhmmToMinutes(v(k));
      return m === null ? null : end && m === 1439 ? 1440 : m;
    };
    const unit = v("unit") as Settings["unit"];
    const goalRaw = n("goal");
    // Goal field is in the unit shown when it was filled.
    const goalMl = s.unit === "ml" ? Math.round(goalRaw) : ozToMl(goalRaw);
    const times = [t("activeStart"), t("activeEnd", true), t("quietStart"), t("quietEnd", true)];
    if (times.some((x) => x === null)) return "times must look like 09:00";
    const ints = ["interval", "minGap", "dailyMax", "peckish", "hungry", "veryHungry"].map(n);
    if (ints.some((x) => !Number.isInteger(x))) return "minutes must be whole numbers";
    if (!Number.isFinite(goalMl)) return "goal must be a number";
    return {
      ...s,
      petName: v("petName").trim(),
      theme: v("theme") as Settings["theme"],
      motion: v("motion") as Settings["motion"],
      chill: c("chill"),
      noJokes: c("noJokes"),
      unit,
      goalMl,
      activeStart: times[0]!,
      activeEnd: times[1]!,
      remindersEnabled: c("remindersEnabled"),
      reminderIntervalMin: ints[0],
      minGapMin: ints[1],
      dailyMax: ints[2],
      quietEnabled: c("quietEnabled"),
      quietStart: times[2]!,
      quietEnd: times[3]!,
      peckishMin: ints[3],
      hungryMin: ints[4],
      veryHungryMin: ints[5],
      closeToTray: c("closeToTray"),
    };
  }

  private async save() {
    if (this.filling) return;
    const next = this.read();
    if (typeof next !== "string" && !next.petName) {
      this.ctx.say("pet name can't be empty.", "err");
      this.fill(this.ctx.snap().settings);
      return;
    }
    if (typeof next === "string") {
      this.ctx.say(next, "err");
      return;
    }
    try {
      this.ctx.apply(await api.saveSettings(next));
      this.ctx.say("settings saved.", "ok");
    } catch (e) {
      this.ctx.say(`not saved: ${errorText(e)}`, "err");
      this.fill(this.ctx.snap().settings);
    }
  }

  render() {
    const s = this.ctx.snap();
    this.fill(s.settings);
    const pet = s.settings.petName;
    this.goalNote.textContent = `2,000 mL is only an example. needs vary with body, climate and activity; this is not medical advice, and a clinician's guidance always comes first. ${pet} is not a health indicator.`;
    this.trayHint.textContent = s.settings.trayVerified ? `closing the window keeps ${pet} running in the tray.` : "confirm the tray icon above first.";
    const tomorrow = s.settings.goalMl !== s.todayGoal;
    this.goalHint.textContent = tomorrow
      ? `today's goal stays ${formatAmount(s.todayGoal, s.settings.unit)}; ${formatAmount(s.settings.goalMl, s.settings.unit)} starts tomorrow.`
      : "goal changes apply from the next day.";
    this.renderStatus(s);
    const p = s.platform;
    this.once("tray", [p.trayCreated, p.trayError, p.os, p.launcherInstalled, s.settings.trayVerified, s.settings.closeToTray], () => this.renderTray(s));
    this.once("startup", [p.startup, p.os, p.autostarted], () => this.renderStartup(s));
    this.once("data", [s.storage.path, s.pendingImport, s.settings.unit, p.version, p.os], () => this.renderData(s));
  }

  private once(name: string, deps: unknown[], render: () => void) {
    const key = JSON.stringify(deps);
    if (this.keys[name] === key) return;
    this.keys[name] = key;
    render();
  }

  private renderStatus(s: Snapshot) {
    const p = s.platform;
    const r = s.reminders;
    const t = (ms: number) => clockAt(ms, s.offsetMin);
    const reminders = !s.settings.remindersEnabled
      ? "off"
      : r.pausedToday
        ? "paused for today"
        : r.snoozeUntil
          ? `snoozed until ${t(r.snoozeUntil)}`
          : r.due
            ? `next around ${t(r.due)} (${r.sentToday} sent today)`
            : `${r.block === "goalMet" ? "done, goal reached" : "none left today"} (${r.sentToday} sent)`;
    const n = p.notifier;
    const items: [string, string, string?][] = [
      ["process", p.autostarted ? "running (started at sign-in)" : "running", "good"],
      ["reminders", reminders],
      ["notifications", n.available ? `${n.server ?? "available"}${n.actions ? " · click opens app" : ""}` : `unavailable: ${n.error ?? "unknown"}`, n.available ? undefined : "err"],
      ["last notification", s.lastNotify ? `${t(s.lastNotify.ts)} ${s.lastNotify.kind}: ${s.lastNotify.message}` : "none sent yet", s.lastNotify && !s.lastNotify.ok ? "err" : undefined],
      ["theme", palette(s).name],
      ["storage", s.storage.lastSaveOk ? "saved" : `not saved: ${s.storage.lastError}`, s.storage.lastSaveOk ? undefined : "err"],
    ];
    if (p.clockOffsetMin) items.push(["test clock", `shifted ${p.clockOffsetMin} min`, "warn"]);
    clear(this.status, ...items.flatMap(([k, v, cls]) => [h("dt", {}, k), h("dd", { class: cls ?? "" }, v)]));
  }

  private renderTray(s: Snapshot) {
    const p = s.platform;
    const set = s.settings;
    const nodes: HTMLElement[] = [];
    if (!p.trayCreated) {
      nodes.push(h("p", { class: "err" }, `tray icon could not be created: ${p.trayError ?? "unknown error"}`));
    } else if (set.trayVerified) {
      nodes.push(h("p", {}, h("span", { class: "good" }, "tray confirmed. "), "the droplet in your tray can log, snooze, pause and quit."));
      nodes.push(h("button", { class: "btn ghost small", type: "button", onclick: () => void this.confirmTray(false) }, "I can't see it anymore"));
    } else {
      nodes.push(
        h("p", {}, `${set.petName} added a droplet icon to your system tray. creating an icon doesn't prove your bar shows it, so please check.`),
        p.os === "windows" ? h("p", { class: "hint" }, "on Windows it may be hidden in the overflow area (the ^ arrow next to the clock).") : h("p", { class: "hint" }, "on Omarchy it sits in the bar's tray, left of the system icons."),
        h(
          "div",
          { class: "btn-row" },
          h("button", { class: "btn", type: "button", onclick: () => void this.confirmTray(true) }, "I can see it"),
          h("button", { class: "btn ghost", type: "button", onclick: () => void this.confirmTray(false) }, "no tray here"),
        ),
      );
    }
    if (!set.trayVerified || !set.closeToTray) {
      nodes.push(h("p", { class: "hint" }, `closing the window quits hydration.sys${p.launcherInstalled ? "; open it again from your app launcher" : ""}. reminders only run while it is running.`));
    }
    clear(this.trayBox, ...nodes);
  }

  private renderStartup(s: Snapshot) {
    const st = s.platform.startup;
    const linux = s.platform.os === "linux";
    const nodes: HTMLElement[] = [];
    const sw = h("input", { type: "checkbox", class: "switch", id: "autostart", role: "switch", checked: st.pluginEnabled, onchange: (e: Event) => void this.setAutostart((e.target as HTMLInputElement).checked) });
    nodes.push(row("launch on sign-in", sw, "starts quietly: no window focus, no boot animation"));
    if (linux) {
      const honored = st.sessionHonorsXdg;
      nodes.push(
        h(
          "p",
          { class: honored === false ? "warn" : "hint" },
          st.pluginEnabled
            ? honored
              ? "route: XDG autostart entry (~/.config/autostart). this session runs those entries (systemd xdg-desktop-autostart is active)."
              : honored === false
                ? "route: XDG autostart entry, but this session does not seem to run XDG autostart. use the Hyprland line below instead."
                : "route: XDG autostart entry. could not check whether this session runs it."
            : honored === false
              ? "this session does not run XDG autostart entries; the switch may not work here. use the Hyprland line below."
              : "uses an XDG autostart entry, which this session runs at login.",
        ),
      );
      if (st.manualHyprland) nodes.push(h("p", { class: st.pluginEnabled ? "warn" : "good" }, `a manual Hyprland startup line was found in ${st.hyprlandConfig}.${st.pluginEnabled ? " turn the switch off to avoid two launch routes (single-instance prevents a double app, but one route is cleaner)." : ""}`));
      if (st.hyprlandSnippet) {
        nodes.push(
          h(
            "details",
            { class: "snippet" },
            h("summary", {}, `manual alternative (${st.hyprlandLua ? "Hyprland Lua config" : "legacy hyprland.conf"})`),
            h("p", { class: "hint" }, `add this line to ${st.hyprlandConfig ?? "your Hyprland autostart file"}. it runs once per login. remove the line to undo. use either this or the switch, not both.`),
            h("pre", { class: "code", tabindex: 0 }, st.hyprlandSnippet),
          ),
        );
      }
    } else {
      nodes.push(h("p", { class: "hint" }, "uses the Windows sign-in startup list (Settings › Apps › Startup)."));
    }
    if (st.error) nodes.push(h("p", { class: "err" }, st.error));
    clear(this.startupBox, ...nodes);
  }

  private renderData(s: Snapshot) {
    const nodes: HTMLElement[] = [
      h("p", {}, "everything stays on this computer. no account, no cloud sync, no analytics. the app itself makes no network requests."),
      h("p", { class: "hint" }, "file: ", h("code", {}, s.storage.path)),
      h(
        "div",
        { class: "btn-row" },
        h("button", { class: "btn", type: "button", onclick: () => void this.exportJson() }, "export json"),
        h("button", { class: "btn", type: "button", onclick: () => void this.importPick() }, "import json…"),
      ),
    ];
    const p = s.pendingImport;
    if (p) {
      nodes.push(
        h(
          "div",
          { class: "confirm-box", role: "alertdialog", "aria-label": "confirm import" },
          h("p", {}, `import ${p.entries} drinks over ${p.days} days (${p.firstDate ?? "?"} to ${p.lastDate ?? "?"}, ${formatAmount(p.totalMl, s.settings.unit)}) for "${p.petName}"?`),
          h("p", { class: "warn" }, `this replaces your current ${p.currentEntries} entries and settings. a copy of the current file is kept first.`),
          h(
            "div",
            { class: "btn-row" },
            h("button", { class: "btn danger", type: "button", onclick: () => void this.importConfirm() }, "replace my data"),
            h("button", { class: "btn ghost", type: "button", onclick: () => void this.importCancel() }, "cancel"),
          ),
        ),
      );
    }
    const resetInput = h("input", { class: "field", id: "reset-confirm", autocomplete: "off", placeholder: "type reset", "aria-label": "type reset to confirm" });
    nodes.push(
      h(
        "details",
        { class: "danger-zone" },
        h("summary", {}, "reset everything"),
        h("p", { class: "hint" }, "deletes all drinks and settings. a backup copy of the file is kept in the data folder."),
        h("div", { class: "btn-row" }, resetInput, h("button", { class: "btn danger", type: "button", onclick: () => void this.reset(resetInput.value) }, "reset")),
      ),
      h(
        "div",
        { class: "btn-row about" },
        h("span", { class: "dim" }, `hydration.sys v${s.platform.version} · ${s.platform.os}`),
        h("button", { class: "btn ghost small", type: "button", onclick: () => void api.quit() }, "quit"),
      ),
    );
    const open = this.dataBox.querySelector("details.danger-zone")?.hasAttribute("open");
    clear(this.dataBox, ...nodes);
    if (open) this.dataBox.querySelector("details.danger-zone")?.setAttribute("open", "");
  }

  private async run(f: () => Promise<Snapshot | null>, ok?: string) {
    try {
      const s = await f();
      if (s) this.ctx.apply(s);
      if (ok) this.ctx.say(ok, "ok");
    } catch (e) {
      this.ctx.say(errorText(e), "err");
    }
  }

  private async testNotify() {
    await this.run(() => api.testNotification());
    const n = this.ctx.snap().lastNotify;
    this.notifyResult.textContent = n ? (n.ok ? `sent: ${n.message}. if nothing appeared, check do-not-disturb.` : `failed: ${n.message}`) : "";
    this.notifyResult.className = n && !n.ok ? "hint err" : "hint";
  }

  private confirmTray(works: boolean) {
    return this.run(() => api.confirmTray(works), works ? "tray confirmed." : "okay. closing the window will quit.");
  }

  private setAutostart(on: boolean) {
    return this.run(() => api.setAutostart(on), on ? "byte will start quietly at sign-in." : "launch on sign-in turned off.");
  }

  private async exportJson() {
    try {
      const path = await api.exportJson();
      if (path) this.ctx.say(`exported to ${path}`, "ok");
    } catch (e) {
      this.ctx.say(`export failed: ${errorText(e)}`, "err");
    }
  }

  private importPick() {
    return this.run(() => api.importPick());
  }

  private importConfirm() {
    return this.run(() => api.importConfirm(), "import complete.");
  }

  private importCancel() {
    return this.run(() => api.importCancel(), "import cancelled. nothing changed.");
  }

  private reset(text: string) {
    if (text.trim() !== "reset") {
      this.ctx.say("type reset to confirm.", "err");
      return;
    }
    return this.run(() => api.reset(text), "all data reset. a backup was kept.");
  }
}
