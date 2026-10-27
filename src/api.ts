// The only bridge to the native side. Every call maps to one Rust command;
// the webview holds no state of its own beyond the last snapshot.

import type { Settings, Snapshot } from "./core/types";

export interface Backend {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  onSnapshot(cb: (s: Snapshot) => void): void;
  onNavigate(cb: (tab: string) => void): void;
}

let backend: Backend | null = null;

export async function connect(): Promise<Backend> {
  if (backend) return backend;
  if (import.meta.env.MODE === "mock") {
    const { createMock } = await import("./mock");
    backend = createMock();
  } else {
    const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
    backend = {
      invoke: (cmd, args) => invoke(cmd, args),
      onSnapshot: (cb) => void listen<Snapshot>("snapshot", (e) => cb(e.payload)),
      onNavigate: (cb) => void listen<string>("navigate", (e) => cb(e.payload)),
    };
  }
  return backend;
}

function b(): Backend {
  if (!backend) throw new Error("backend not connected");
  return backend;
}

export const api = {
  snapshot: () => b().invoke<Snapshot>("get_snapshot"),
  log: (ml: number) => b().invoke<Snapshot>("log_drink", { ml }),
  undo: () => b().invoke<Snapshot>("undo_last"),
  remove: (id: string) => b().invoke<Snapshot>("delete_entry", { id }),
  saveSettings: (settings: Settings) => b().invoke<Snapshot>("update_settings", { settings }),
  onboard: (settings: Settings) => b().invoke<Snapshot>("complete_onboarding", { settings }),
  snooze: (minutes: 15 | 30 | 60) => b().invoke<Snapshot>("snooze", { minutes }),
  pauseToday: () => b().invoke<Snapshot>("pause_today"),
  resume: () => b().invoke<Snapshot>("resume_reminders"),
  testNotification: () => b().invoke<Snapshot>("test_notification"),
  setAutostart: (enabled: boolean) => b().invoke<Snapshot>("set_autostart", { enabled }),
  confirmTray: (works: boolean) => b().invoke<Snapshot>("confirm_tray", { works }),
  exportJson: () => b().invoke<string | null>("export_json"),
  exportText: (content: string) => b().invoke<string | null>("export_text", { content }),
  importPick: () => b().invoke<Snapshot | null>("import_pick"),
  importConfirm: () => b().invoke<Snapshot>("import_confirm"),
  importCancel: () => b().invoke<Snapshot>("import_cancel"),
  reset: (confirm: string) => b().invoke<Snapshot>("reset_all", { confirm }),
  bootShown: () => b().invoke<Snapshot>("mark_boot_shown"),
  dismissNotice: () => b().invoke<Snapshot>("dismiss_notice"),
  hide: () => b().invoke<void>("hide_window"),
  quit: () => b().invoke<void>("quit_app"),
};

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
