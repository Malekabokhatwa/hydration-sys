// Browser-only stand-in for the native side, used by `npm run dev:mock` and
// the Playwright tests. It is NOT bundled into the real app. Hunger and
// reminder rules here are simplified approximations of the Rust core, enough
// to render every screen; the authoritative logic lives in src-tauri/src/core.
//
// URL parameters: ?scenario=fresh|today|hungry|veryHungry|goal|history
//                 &now=<ISO time>  &os=linux|windows  &theme=omarchy|phosphor|amber

import type { Backend } from "./api";
import { addDays } from "./core/dates";
import type { Entry, Pet, Settings, Snapshot, Stage } from "./core/types";

const NORD: Record<string, string> = {
  mode: "dark", accent: "#81a1c1", selection: "#434c5e", muted: "#4c566a", background: "#2e3440",
  dark_background: "#222730", darker_background: "#191c23", lighter_background: "#3b4252", foreground: "#d8dee9",
  dark_foreground: "#667080", light_foreground: "#adb5c4", red: "#bf616a", yellow: "#ebcb8b", green: "#a3be8c",
  cyan: "#88c0d0", blue: "#81a1c1", magenta: "#b48ead",
};

const DEFAULTS: Settings = {
  petName: "byte", goalMl: 2000, unit: "ml", activeStart: 540, activeEnd: 1260, remindersEnabled: true,
  reminderIntervalMin: 75, minGapMin: 45, dailyMax: 8, quietEnabled: false, quietStart: 720, quietEnd: 780,
  peckishMin: 90, hungryMin: 150, veryHungryMin: 240, closeToTray: false, trayVerified: false, theme: "omarchy",
  chill: false, noJokes: false, motion: "system", onboarded: true,
};

function localKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function atLocal(key: string, minute: number): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, Math.floor(minute / 60), minute % 60).getTime();
}

export function createMock(): Backend {
  const q = new URLSearchParams(location.search);
  const scenario = q.get("scenario") ?? "today";
  const clockStart = q.get("now") ? Date.parse(q.get("now")!) : Date.now();
  const realStart = Date.now();
  const now = () => clockStart + (Date.now() - realStart);
  const settings: Settings = { ...DEFAULTS, theme: (q.get("theme") as Settings["theme"]) ?? "omarchy" };
  let entries: Entry[] = [];
  const dayGoals: Record<string, number> = {};
  let paused = false;
  let snoozeUntil: number | null = null;
  let n = 0;
  let autostart = false;
  let lastNotify: Snapshot["lastNotify"] = null;
  let pending: Snapshot["pendingImport"] = null;
  const listeners: ((s: Snapshot) => void)[] = [];

  const add = (ts: number, ml: number) =>
    entries.push({ id: `m${(n++).toString(16).padStart(6, "0")}${ts.toString(16)}`, ts, date: localKey(ts), ml, offsetMin: -new Date(ts).getTimezoneOffset() });

  const today = localKey(now());
  if (scenario === "fresh") settings.onboarded = false;
  if (scenario === "today" || scenario === "history") {
    add(atLocal(today, 9 * 60 + 12), 250);
    add(atLocal(today, 10 * 60 + 40), 150);
    add(Math.min(now() - 25 * 60_000, atLocal(today, 13 * 60 + 5)), 500);
  }
  if (scenario === "hungry") add(now() - 160 * 60_000, 250);
  if (scenario === "veryHungry") add(now() - 260 * 60_000, 150);
  if (scenario === "goal") {
    add(atLocal(today, 9 * 60), 500);
    add(atLocal(today, 11 * 60), 750);
    add(now() - 40 * 60_000, 800);
  }
  if (scenario === "history") {
    // ~20 weeks of plausible history with a few missed days.
    for (let i = 1; i < 140; i++) {
      const key = addDays(today, -i);
      dayGoals[key] = i > 60 ? 1800 : 2000;
      const r = Math.sin(i * 12.9898) * 43758.5453;
      const rnd = r - Math.floor(r);
      if (rnd < 0.12) continue;
      const count = 2 + Math.floor(rnd * 6);
      for (let k = 0; k < count; k++) add(atLocal(key, 8 * 60 + 30 + k * 95 + Math.floor(rnd * 40)), [150, 250, 250, 330, 500][(k + i) % 5]);
    }
  }
  dayGoals[today] = settings.goalMl;

  let seq = 1;
  function snapshot(): Snapshot {
    const t = now();
    const tkey = localKey(t);
    if (dayGoals[tkey] === undefined) dayGoals[tkey] = settings.goalMl;
    const todays = entries.filter((e) => e.date === tkey).sort((a, b) => a.ts - b.ts);
    const total = todays.reduce((s, e) => s + e.ml, 0);
    const goal = dayGoals[tkey];
    const win: [number, number] = [atLocal(tkey, settings.activeStart), atLocal(tkey, settings.activeEnd)];
    const last = todays[todays.length - 1]?.ts ?? win[0];
    const mins = Math.max(0, Math.round((Math.min(t, win[1]) - Math.max(last, win[0])) / 60_000));
    const goalMet = total >= goal;
    const stage: Stage = goalMet ? "fed" : mins >= settings.veryHungryMin ? "veryHungry" : mins >= settings.hungryMin ? "hungry" : mins >= settings.peckishMin ? "peckish" : "fed";
    const inActive = t >= win[0] && t < win[1];
    const sinceLast = todays.length ? t - todays[todays.length - 1].ts : Infinity;
    const pet: Pet = goalMet ? (sinceLast < 180_000 ? "happy" : "goal") : sinceLast < 180_000 ? "happy" : !inActive ? "sleeping"
      : ({ fed: "idle", peckish: "thirsty", hungry: "hungry", veryHungry: "veryHungry" } as const)[stage];
    const due = Math.max(last, win[0]) + settings.reminderIntervalMin * 60_000;
    return {
      seq: seq++, now: t, today: tkey, offsetMin: -new Date(t).getTimezoneOffset(), window: win, entries: entries.slice(), dayGoals: { ...dayGoals },
      settings: { ...settings }, todayGoal: goal, todayTotal: total,
      hunger: { stage, pet, hungryForMin: mins, goalMet, inActiveHours: inActive },
      reminders: {
        fire: false, due: goalMet || paused || due >= win[1] ? null : due,
        block: paused ? "pausedToday" : goalMet ? "goalMet" : snoozeUntil && t < snoozeUntil ? "snoozed" : !inActive ? "beforeActive" : "notDue",
        sentToday: 2, lastReminderTs: t - 50 * 60_000, snoozeUntil: snoozeUntil && snoozeUntil > t ? snoozeUntil : null, pausedToday: paused,
      },
      storage: { path: "~/.local/share/io.github.malekabokhatwa.hydrationsys/hydration.json", lastSaveOk: true, lastError: null, notice: q.get("notice") ? { kind: "recoveredFromBackup", kept: "hydration.corrupt-1.json", reason: "invalid JSON" } : null },
      lastBootDate: q.get("boot") ? null : tkey, lastNotify, pendingImport: pending,
      platform: {
        os: q.get("os") ?? "linux", version: "1.0.0", autostarted: false, bootEligible: !!q.get("boot"),
        startup: { pluginEnabled: autostart, sessionHonorsXdg: true, manualHyprland: false, hyprlandConfig: "~/.config/hypr/autostart.lua", hyprlandLua: true, hyprlandSnippet: 'o.launch_on_start("/home/you/.local/bin/hydration-sys --autostarted")', exe: "/home/you/.local/bin/hydration-sys", error: null },
        notifier: { available: true, server: "quickshell 1.2", capabilities: ["actions", "body", "persistence"], actions: true, error: null },
        trayCreated: true, trayError: null, launcherInstalled: true,
        theme: { name: "Nord", colors: NORD }, clockOffsetMin: 0,
      },
    };
  }

  const emit = () => {
    const s = snapshot();
    listeners.forEach((l) => l(s));
    return s;
  };

  const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
    get_snapshot: () => snapshot(),
    log_drink: (a) => {
      const ml = Number(a.ml);
      if (!Number.isInteger(ml) || ml < 1 || ml > 2000) throw "amount must be a whole number from 1 to 2000 mL";
      add(now(), ml);
      return emit();
    },
    undo_last: () => {
      const last = entries.reduce<Entry | null>((m, e) => (!m || e.ts > m.ts ? e : m), null);
      entries = entries.filter((e) => e !== last);
      return emit();
    },
    delete_entry: (a) => {
      entries = entries.filter((e) => e.id !== a.id);
      return emit();
    },
    update_settings: (a) => {
      const next = a.settings as Settings;
      if (next.closeToTray && !settings.trayVerified) throw "confirm the tray icon works before enabling close-to-tray";
      Object.assign(settings, next, { onboarded: settings.onboarded, trayVerified: settings.trayVerified });
      return emit();
    },
    complete_onboarding: (a) => {
      Object.assign(settings, a.settings as Settings, { onboarded: true });
      dayGoals[localKey(now())] = settings.goalMl;
      return emit();
    },
    snooze: (a) => {
      snoozeUntil = now() + Number(a.minutes) * 60_000;
      return emit();
    },
    pause_today: () => ((paused = true), emit()),
    resume_reminders: () => ((paused = false), (snoozeUntil = null), emit()),
    test_notification: () => {
      lastNotify = { ts: now(), ok: true, kind: "test", message: "delivered to quickshell 1.2 (mock)" };
      return emit();
    },
    set_autostart: (a) => ((autostart = !!a.enabled), emit()),
    confirm_tray: (a) => {
      settings.trayVerified = !!a.works;
      if (!a.works) settings.closeToTray = false;
      return emit();
    },
    export_json: () => "/home/you/hydration-sys-export.json",
    export_text: () => "/home/you/hydration-log.txt",
    import_pick: () => {
      pending = { entries: 42, days: 12, firstDate: addDays(today, -12), lastDate: today, totalMl: 21_000, petName: "byte", currentEntries: entries.length };
      return emit();
    },
    import_confirm: () => ((pending = null), emit()),
    import_cancel: () => ((pending = null), emit()),
    reset_all: (a) => {
      if (a.confirm !== "reset") throw "type reset to confirm";
      entries = [];
      settings.onboarded = false;
      return emit();
    },
    mark_boot_shown: () => emit(),
    dismiss_notice: () => emit(),
    hide_window: () => undefined,
    quit_app: () => undefined,
  };

  return {
    async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      const fn = handlers[cmd];
      if (!fn) throw `unknown command ${cmd}`;
      return fn(args) as T;
    },
    onSnapshot: (cb) => void listeners.push(cb),
    onNavigate: () => {},
  };
}
