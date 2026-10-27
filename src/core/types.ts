// Mirrors the snapshot the native side emits (src-tauri/src/lib.rs Snapshot).

export type Unit = "ml" | "oz";
export type Theme = "omarchy" | "phosphor" | "amber";
export type Motion = "system" | "reduce" | "full";
export type Stage = "fed" | "peckish" | "hungry" | "veryHungry";
export type Pet = "idle" | "happy" | "thirsty" | "hungry" | "veryHungry" | "recovering" | "goal" | "sleeping";
export type Block =
  | "disabled" | "pausedToday" | "goalMet" | "dailyMax" | "doneForToday"
  | "beforeActive" | "snoozed" | "quiet" | "notDue";

export interface Entry {
  id: string;
  ts: number;
  date: string;
  ml: number;
  offsetMin: number;
}

export interface Settings {
  petName: string;
  goalMl: number;
  unit: Unit;
  activeStart: number;
  activeEnd: number;
  remindersEnabled: boolean;
  reminderIntervalMin: number;
  minGapMin: number;
  dailyMax: number;
  quietEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  peckishMin: number;
  hungryMin: number;
  veryHungryMin: number;
  closeToTray: boolean;
  trayVerified: boolean;
  theme: Theme;
  chill: boolean;
  noJokes: boolean;
  motion: Motion;
  onboarded: boolean;
}

export interface Hunger {
  stage: Stage;
  pet: Pet;
  hungryForMin: number;
  goalMet: boolean;
  inActiveHours: boolean;
}

export interface Reminders {
  fire: boolean;
  due: number | null;
  block: Block | null;
  sentToday: number;
  lastReminderTs: number | null;
  snoozeUntil: number | null;
  pausedToday: boolean;
}

export type LoadNotice =
  | { kind: "repaired"; kept: string; dropped: number }
  | { kind: "recoveredFromBackup"; kept: string; reason: string }
  | { kind: "startedFresh"; kept: string; reason: string };

export interface ImportPreview {
  entries: number;
  days: number;
  firstDate: string | null;
  lastDate: string | null;
  totalMl: number;
  petName: string;
  currentEntries: number;
}

export interface StartupStatus {
  pluginEnabled: boolean;
  sessionHonorsXdg: boolean | null;
  manualHyprland: boolean;
  hyprlandConfig: string | null;
  hyprlandLua: boolean;
  hyprlandSnippet: string | null;
  exe: string;
  error: string | null;
}

export interface NotifierInfo {
  available: boolean;
  server: string | null;
  capabilities: string[];
  actions: boolean;
  error: string | null;
}

export interface Snapshot {
  /** Monotonic; a lower seq than the one shown is stale and ignored. */
  seq: number;
  now: number;
  today: string;
  offsetMin: number;
  window: [number, number];
  entries: Entry[];
  dayGoals: Record<string, number>;
  settings: Settings;
  todayGoal: number;
  todayTotal: number;
  hunger: Hunger;
  reminders: Reminders;
  storage: { path: string; lastSaveOk: boolean; lastError: string | null; notice: LoadNotice | null };
  lastBootDate: string | null;
  lastNotify: { ts: number; ok: boolean; kind: string; message: string } | null;
  pendingImport: ImportPreview | null;
  platform: {
    os: string;
    version: string;
    autostarted: boolean;
    bootEligible: boolean;
    startup: StartupStatus;
    notifier: NotifierInfo;
    trayCreated: boolean;
    trayError: string | null;
    launcherInstalled: boolean;
    theme: { name: string | null; colors: Record<string, string> } | null;
    clockOffsetMin: number;
  };
}
