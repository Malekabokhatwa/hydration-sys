import { api, errorText } from "../api";
import { hhmmToMinutes, minutesToHHMM } from "../core/dates";
import type { Settings, Snapshot } from "../core/types";
import { ozToMl } from "../core/units";
import { clear, h } from "./dom";
import { PetView } from "./pet";
import type { Ctx } from "./today";

const STEPS = ["hello", "goal", "reminders", "tray", "startup"] as const;
type Step = (typeof STEPS)[number];

/** First-run setup. Every choice has a working "not now". */
export class Onboarding {
  readonly el: HTMLElement;
  private step: Step = "hello";
  private draft: Settings;
  private body = h("div", { class: "ob-body" });
  private pet = new PetView();
  private msg = h("p", { class: "hint", "aria-live": "polite" });
  private autostart = false;

  constructor(private ctx: Ctx, private done: () => void) {
    this.draft = { ...ctx.snap().settings };
    this.el = h(
      "div",
      { class: "onboarding", role: "dialog", "aria-modal": "true", "aria-labelledby": "ob-title" },
      h("div", { class: "ob-card panel" }, h("span", { class: "panel-label", "aria-hidden": "true" }, "setup.sh"), h("div", { class: "ob-pet" }, this.pet.el), this.body, this.msg),
    );
    this.render();
  }

  private go(step: Step) {
    this.step = step;
    this.msg.textContent = "";
    this.render();
    this.focusFirst();
  }

  focusFirst() {
    (this.body.querySelector("input, select, button.primary") as HTMLElement | null)?.focus();
  }

  private next() {
    const i = STEPS.indexOf(this.step);
    if (i < STEPS.length - 1) this.go(STEPS[i + 1]);
    else void this.finish();
  }

  /** Step buttons. The primary one submits the step's form (so Enter works). */
  private nav(primary: string, secondary?: [string, () => void]) {
    const i = STEPS.indexOf(this.step);
    return h(
      "div",
      { class: "ob-nav" },
      h("span", { class: "dim" }, `${i + 1}/${STEPS.length}`),
      i > 0 ? h("button", { class: "btn ghost", type: "button", onclick: () => this.go(STEPS[i - 1]) }, "back") : null,
      secondary ? h("button", { class: "btn ghost", type: "button", onclick: secondary[1] }, secondary[0]) : null,
      h("button", { class: "btn primary", type: "submit" }, primary),
    );
  }

  private form(onSubmit: () => void, ...children: (HTMLElement | null)[]): HTMLFormElement {
    return h("form", { class: "ob-form", onsubmit: (e: Event) => { e.preventDefault(); onSubmit(); } }, ...children);
  }

  private render() {
    const s = this.ctx.snap();
    const d = this.draft;
    this.pet.update(d.petName || "byte", this.step === "hello" ? "happy" : this.step === "reminders" ? "thirsty" : "idle", 0.5, this.ctx.motion());
    const title = (t: string) => h("h1", { id: "ob-title" }, t);
    const name = d.petName.trim() || "byte";
    switch (this.step) {
      case "hello": {
        const nameInput = h("input", { class: "field", id: "ob-name", maxlength: 24, value: d.petName, autocomplete: "off" });
        nameInput.addEventListener("input", () => (d.petName = nameInput.value));
        const nameNext = () => {
          if (!d.petName.trim()) d.petName = "byte";
          this.next();
        };
        clear(
          this.body,
          this.form(nameNext,
          title(`${name}.exe installed.`),
          h("p", {}, "a tiny pet that lives in your terminal and runs on water. log a drink, it stays happy. forget for a few hours, it gets hungry. one sip always fixes it."),
          h("label", { for: "ob-name" }, "name your pet"),
          nameInput,
          this.nav("next")),
        );
        break;
      }
      case "goal": {
        const unit = h("select", { class: "field", id: "ob-unit" }, h("option", { value: "ml" }, "mL"), h("option", { value: "oz" }, "fl oz (US)"));
        unit.value = d.unit;
        const goal = h("input", { class: "field num", id: "ob-goal", type: "number", inputmode: "numeric", value: d.unit === "ml" ? d.goalMl : Math.round(d.goalMl / 29.5735) });
        const from = h("input", { class: "field time", id: "ob-from", type: "time", step: 300, value: minutesToHHMM(d.activeStart) });
        const to = h("input", { class: "field time", id: "ob-to", type: "time", step: 300, value: minutesToHHMM(d.activeEnd === 1440 ? 1439 : d.activeEnd) });
        unit.addEventListener("change", () => {
          d.unit = unit.value as Settings["unit"];
          goal.value = String(d.unit === "ml" ? d.goalMl : Math.round(d.goalMl / 29.5735));
        });
        const goalNext = () => {
          const g = Number(goal.value);
          const ml = d.unit === "ml" ? Math.round(g) : ozToMl(g);
          const a = hhmmToMinutes(from.value);
          let b = hhmmToMinutes(to.value);
          if (b === 1439) b = 1440;
          if (!Number.isFinite(ml) || ml < 250 || ml > 10000) return void (this.msg.textContent = "goal must be between 250 and 10,000 mL.");
          if (a === null || b === null || b - a < 60) return void (this.msg.textContent = "active hours must start before they end, at least an hour apart.");
          Object.assign(d, { goalMl: ml, activeStart: a, activeEnd: b });
          this.next();
        };
        clear(
          this.body,
          this.form(goalNext,
          title("daily goal"),
          h("div", { class: "pair" }, h("div", { class: "row" }, h("label", { for: "ob-goal" }, "goal per day"), goal), h("div", { class: "row" }, h("label", { for: "ob-unit" }, "unit"), unit)),
          h("p", { class: "note" }, `2,000 mL is an example, not medical advice. needs vary; a clinician's guidance always comes first. ${name} is not a health indicator.`),
          h("div", { class: "pair" }, h("div", { class: "row" }, h("label", { for: "ob-from" }, "active from"), from), h("div", { class: "row" }, h("label", { for: "ob-to" }, "until"), to)),
          h("p", { class: "hint" }, `${name} only gets hungry, and only reminds you, during active hours.`),
          this.nav("next")),
        );
        break;
      }
      case "reminders": {
        const n = s.platform.notifier;
        const result = h("p", { class: "hint", "aria-live": "polite" });
        const remOn = () => {
          d.remindersEnabled = true;
          this.next();
        };
        clear(
          this.body,
          this.form(remOn,
          title("gentle reminders"),
          h("p", {}, `about every ${d.reminderIntervalMin} minutes without a drink, during active hours only, at most ${d.dailyMax} a day, and never after you hit your goal. new ones replace old ones instead of piling up. snooze or pause anytime from the tray.`),
          h("p", { class: "hint" }, n.available ? `they go through your desktop's notification service (${n.server ?? "system"}), so do-not-disturb is respected.` : `notifications look unavailable here: ${n.error ?? "unknown"}. you can still use the app; the tray and window show byte's mood.`),
          h("button", { class: "btn ghost", type: "button", onclick: async () => {
            try {
              this.ctx.apply(await api.testNotification());
              const r = this.ctx.snap().lastNotify;
              result.textContent = r ? (r.ok ? "sent. did you see it? if not, check do-not-disturb." : `failed: ${r.message}`) : "";
            } catch (e) {
              result.textContent = errorText(e);
            }
          } }, "send a test notification"),
          result,
          this.nav("turn on reminders", ["not now", () => {
            d.remindersEnabled = false;
            this.next();
          }])),
        );
        break;
      }
      case "tray": {
        const trayYes = () => void (s.platform.trayCreated ? this.confirmTray(true) : this.next());
        clear(
          this.body,
          this.form(trayYes,
          title("find the droplet"),
          h("p", {}, s.platform.trayCreated ? `${name} just put a droplet icon in your system tray. its menu can log water, snooze, pause and quit.` : `the tray icon could not be created (${s.platform.trayError ?? "unknown"}). closing the window will quit the app.`),
          h("p", { class: "hint" }, s.platform.os === "windows" ? "on Windows it may hide in the overflow area (^ next to the clock)." : "on Omarchy it shows in the bar's tray area. can you see it?"),
          s.platform.trayCreated
            ? this.nav("yes, I see it", ["no", () => void this.confirmTray(false)])
            : this.nav("next")),
        );
        break;
      }
      case "startup": {
        const sw = h("input", { type: "checkbox", class: "switch", id: "ob-autostart", role: "switch", checked: this.autostart });
        sw.addEventListener("change", () => (this.autostart = sw.checked));
        const st = s.platform.startup;
        const verified = this.ctx.snap().settings.trayVerified;
        clear(
          this.body,
          this.form(() => void this.finish(),
          title("start with your computer?"),
          h("p", {}, "reminders only work while hydration.sys is running. it can start quietly when you sign in: no window grabbing focus, no animation."),
          h("p", { class: "hint" }, verified ? "with a working tray it starts hidden in the tray." : "without a confirmed tray it starts as a normal window, so you always have a way to reach it."),
          s.platform.os === "linux" && st.sessionHonorsXdg === false
            ? h("p", { class: "warn" }, "this session doesn't seem to run XDG autostart entries. settings shows a Hyprland line you can add instead.")
            : null,
          h("div", { class: "row inline" }, h("label", { for: "ob-autostart" }, "launch on sign-in"), sw),
          h("p", { class: "hint" }, "off by default. you can change it later in settings."),
          this.nav("finish")),
        );
        break;
      }
    }
  }

  private async confirmTray(works: boolean) {
    try {
      this.ctx.apply(await api.confirmTray(works));
      this.draft.trayVerified = works;
      this.draft.closeToTray = works;
    } catch (e) {
      this.msg.textContent = errorText(e);
      return;
    }
    this.next();
  }

  private async finish() {
    try {
      if (this.autostart !== this.ctx.snap().platform.startup.pluginEnabled) this.ctx.apply(await api.setAutostart(this.autostart));
      const s = await api.onboard({ ...this.draft, petName: this.draft.petName.trim() || "byte" });
      this.ctx.apply(s);
      this.ctx.say(`setup complete. say hi to ${s.settings.petName}.`, "ok");
      this.done();
    } catch (e) {
      this.msg.textContent = `could not save: ${errorText(e)}`;
    }
  }
}

export function snapshotNeedsOnboarding(s: Snapshot): boolean {
  return !s.settings.onboarded;
}
