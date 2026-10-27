//! hydration.sys native side: owns the data file, the reminder scheduler, the
//! tray and notifications. The webview only renders snapshots and calls the
//! commands below; it never schedules anything itself.

pub mod core;
mod notify;
mod platform;
mod tray;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::Local;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

use crate::core::hunger::Stage;
use crate::core::model::{NotifyRecord, Settings};
use crate::core::state::{Core, CoreView};
use crate::core::storage::Store;
use crate::core::voice;
use crate::notify::{Action, Notifier, NotifierInfo};
use crate::platform::{OmarchyTheme, StartupStatus};

pub const AUTOSTART_FLAG: &str = "--autostarted";

/// Locks that survive a panicking holder instead of cascading the panic.
fn lk<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}
const TICK: Duration = Duration::from_secs(60);
const MAX_IMPORT_BYTES: u64 = 20 * 1024 * 1024;

pub struct App {
    core: Mutex<Core>,
    wake: Condvar,
    clock_offset_ms: i64,
    autostarted: bool,
    notifier: Notifier,
    startup: Mutex<StartupStatus>,
    theme: Mutex<(Option<SystemTime>, Option<OmarchyTheme>)>,
    tray: Mutex<Option<tray::Tray>>,
    tray_error: Mutex<Option<String>>,
    tray_key: Mutex<String>,
    /// Whether we last showed or hid the window. Asking the window right
    /// after hide() can still report "visible", which made the tray label lie.
    visible: AtomicBool,
    seq: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformView {
    pub os: &'static str,
    pub version: &'static str,
    pub autostarted: bool,
    pub boot_eligible: bool,
    pub startup: StartupStatus,
    pub notifier: NotifierInfo,
    pub tray_created: bool,
    pub tray_error: Option<String>,
    pub launcher_installed: bool,
    pub theme: Option<OmarchyTheme>,
    pub clock_offset_min: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    /// Increases with every snapshot so the UI can drop stale ones that
    /// arrive out of order (events vs. command replies).
    pub seq: u64,
    #[serde(flatten)]
    pub core: CoreView,
    pub platform: PlatformView,
}

impl App {
    fn now(&self) -> i64 {
        let real = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        real + self.clock_offset_ms
    }

    fn lock(&self) -> MutexGuard<'_, Core> {
        self.core.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn snapshot(&self) -> Snapshot {
        let now = self.now();
        let core = self.lock().view(&Local, now);
        let boot_eligible = !self.autostarted && core.last_boot_date.as_deref() != Some(core.today.as_str());
        let theme = {
            let mut t = lk(&self.theme);
            let stamp = platform::omarchy_theme_stamp();
            if t.0 != stamp || (stamp.is_some() && t.1.is_none()) {
                *t = (stamp, platform::omarchy_theme());
            }
            t.1.clone()
        };
        Snapshot {
            seq: self.seq.fetch_add(1, Ordering::SeqCst),
            core,
            platform: PlatformView {
                os: std::env::consts::OS,
                version: env!("CARGO_PKG_VERSION"),
                autostarted: self.autostarted,
                boot_eligible,
                startup: lk(&self.startup).clone(),
                notifier: self.notifier.info(),
                tray_created: lk(&self.tray).is_some(),
                tray_error: lk(&self.tray_error).clone(),
                launcher_installed: platform::launcher_installed(),
                theme,
                clock_offset_min: self.clock_offset_ms / 60_000,
            },
        }
    }

    /// Runs a mutation under the lock, wakes the scheduler, then publishes.
    fn mutate<T>(&self, app: &AppHandle, f: impl FnOnce(&mut Core, i64) -> Result<T, String>) -> Result<Snapshot, String> {
        let now = self.now();
        let res = {
            let mut c = self.lock();
            c.roll_day(&Local, now);
            let r = f(&mut c, now);
            c.dirty = true;
            r
        };
        self.wake.notify_all();
        let snap = publish(app);
        res.map(|_| snap)
    }

    fn notify(&self, kind: &str, summary: &str, body: &str, log_label: Option<&str>) -> NotifyRecord {
        let res = self.notifier.send(summary, body, log_label);
        let rec = NotifyRecord {
            ts: self.now(),
            ok: res.is_ok(),
            kind: kind.into(),
            message: match res {
                Ok(id) if id > 0 => format!("delivered to {} (id {id})", self.notifier.info().server.unwrap_or_else(|| "notification service".into())),
                Ok(_) => "handed to the system notification service".into(),
                Err(e) => e,
            },
        };
        // Kept in memory and written with the next real save; a missing
        // daemon must not cause a disk write every minute.
        self.lock().record_notify(rec.clone());
        rec
    }

    fn refresh_startup(&self, app: &AppHandle) {
        let enabled = app.autolaunch().is_enabled().map_err(|e| e.to_string());
        *lk(&self.startup) = platform::startup_status(enabled);
    }
}

/// Emits the current snapshot to the webview and refreshes the tray.
///
/// Tray/menu calls are main-thread operations; from another thread Tauri
/// dispatches them and *waits*. So the tray is only ever touched from a
/// main-thread closure, and no lock of ours is held across a dispatch.
/// (Updating it from the scheduler thread while the main thread wanted the
/// tray lock deadlocked both.)
fn publish(app: &AppHandle) -> Snapshot {
    let snap = app.state::<App>().snapshot();
    let _ = app.emit("snapshot", &snap);
    let h = app.clone();
    // The closure takes a fresh snapshot on the main thread, so two
    // publishes racing from different threads can't leave the tray stale.
    let _ = app.run_on_main_thread(move || refresh_tray(&h));
    snap
}

fn refresh_tray(app: &AppHandle) {
    let state = app.state::<App>();
    let snap = &state.snapshot();
    let visible = state.visible.load(Ordering::SeqCst);
    let key = format!(
        "{:?}|{:?}|{}|{}|{:?}|{}|{:?}|{}|{}",
        snap.core.hunger.pet,
        snap.core.hunger.stage,
        snap.core.today_total,
        snap.core.today_goal,
        snap.core.settings.unit,
        snap.core.reminders.paused_today,
        snap.core.reminders.snooze_until,
        snap.core.settings.pet_name,
        visible
    );
    let mut last = lk(&state.tray_key);
    if *last != key {
        if let Some(t) = lk(&state.tray).as_ref() {
            t.update(visible, snap);
        }
        *last = key;
    }
}

fn reminder_text(s: &Settings, stage: Stage, seed: u64) -> String {
    let kind = match stage {
        Stage::Hungry => "hungry",
        Stage::VeryHungry => "veryHungry",
        _ => "reminder",
    };
    voice::line(s, kind, seed, None)
}

/// The one scheduler. Sleeps until the next reminder is due, capped at a
/// minute so suspend/resume, clock changes and day rollover are noticed
/// promptly without busy polling.
fn scheduler(app: AppHandle) {
    let state = app.state::<App>();
    loop {
        let now = state.now();
        let due = {
            let mut c = state.lock();
            if c.roll_day(&Local, now) {
                c.save();
            }
            if c.decision(&Local, now).fire {
                let (h, _) = c.hunger(&Local, now);
                let s = c.data.settings.clone();
                let label = format!("log {}", voice::format_ml(tray::amounts(s.unit)[1], s.unit));
                Some((reminder_text(&s, h.stage, (now / 60_000) as u64), s.pet_name.trim().to_string(), label))
            } else {
                None
            }
        };
        if let Some((body, name, label)) = due {
            // Only a delivered reminder counts toward the interval and the
            // daily max; a missing daemon is retried on the next tick.
            if state.notify("reminder", &format!("{name} · hydration.sys"), &body, Some(&label)).ok {
                state.lock().record_reminder(&Local, now);
            }
        }
        publish(&app);

        let c = state.lock();
        let now = state.now();
        let due = c.decision(&Local, now).due.filter(|&d| d > now).map(|d| Duration::from_millis((d - now) as u64));
        let wait = due.map_or(TICK, |d| d.min(TICK)).max(Duration::from_millis(250));
        if c.dirty {
            drop(c);
            state.lock().dirty = false;
            continue;
        }
        let (mut c, _) = state.wake.wait_timeout(c, wait).unwrap_or_else(|p| p.into_inner());
        c.dirty = false;
    }
}

/// Keeps reminders alive even if one loop iteration panics.
fn supervise_scheduler(app: AppHandle) {
    loop {
        let a = app.clone();
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || scheduler(a))).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

pub fn show_main(app: &AppHandle, _activation_token: Option<String>) {
    let Some(w) = app.get_webview_window("main") else { return };
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::GtkWindowExt;
        if let (Some(t), Ok(gw)) = (_activation_token, w.gtk_window()) {
            gw.set_startup_id(&t);
        }
        // Tiling compositors often refuse focus for an already-mapped
        // window; remapping it makes it a fresh, focused window.
        if w.is_visible().unwrap_or(false) && !w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        }
    }
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    app.state::<App>().visible.store(true, Ordering::SeqCst);
    publish(app);
}

fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    app.state::<App>().visible.store(false, Ordering::SeqCst);
    publish(app);
}

pub fn toggle_main(app: &AppHandle) {
    if app.state::<App>().visible.load(Ordering::SeqCst) {
        hide_main(app)
    } else {
        show_main(app, None)
    }
}

fn tray_log(app: &AppHandle, idx: usize) {
    let state = app.state::<App>();
    let unit = state.lock().data.settings.unit;
    let ml = tray::amounts(unit)[idx];
    let r = state.mutate(app, |c, now| c.log_drink(&Local, now, ml).map(|_| ()));
    report_tray_error(app, r.map(|_| ()));
}

fn report_tray_error(app: &AppHandle, r: Result<(), String>) {
    if let Err(e) = r {
        app.state::<App>().notify("error", "hydration.sys", &format!("not saved: {e}"), None);
    }
}

pub fn on_tray_menu(app: &AppHandle, id: &str) {
    let state = app.state::<App>();
    let r = match id {
        "toggle" => {
            toggle_main(app);
            Ok(())
        }
        "log-0" | "log-1" | "log-2" => {
            tray_log(app, id[4..].parse().unwrap_or(1));
            Ok(())
        }
        "snooze-15" | "snooze-30" | "snooze-60" => state.mutate(app, |c, now| c.snooze(&Local, now, id[7..].parse().unwrap_or(30))).map(|_| ()),
        "pause" => {
            let paused = state.snapshot().core.reminders.paused_today;
            state.mutate(app, |c, now| if paused { c.resume(now) } else { c.pause_today(&Local, now) }).map(|_| ())
        }
        "resume" => state.mutate(app, |c, now| c.resume(now)).map(|_| ()),
        "settings" => {
            show_main(app, None);
            let _ = app.emit("navigate", "settings");
            Ok(())
        }
        "quit" => {
            app.exit(0);
            Ok(())
        }
        _ => Ok(()),
    };
    report_tray_error(app, r);
}

// ---------------------------------------------------------------- commands

type Res = Result<Snapshot, String>;

#[tauri::command]
fn get_snapshot(state: State<App>) -> Snapshot {
    state.snapshot()
}

#[tauri::command]
fn log_drink(app: AppHandle, state: State<App>, ml: u32) -> Res {
    state.mutate(&app, |c, now| c.log_drink(&Local, now, ml).map(|_| ()))
}

#[tauri::command]
fn undo_last(app: AppHandle, state: State<App>) -> Res {
    state.mutate(&app, |c, _| c.undo_last().map(|_| ()))
}

#[tauri::command]
fn delete_entry(app: AppHandle, state: State<App>, id: String) -> Res {
    state.mutate(&app, |c, _| match c.delete_entry(&id)? {
        true => Ok(()),
        false => Err("that entry no longer exists".into()),
    })
}

#[tauri::command]
fn update_settings(app: AppHandle, state: State<App>, settings: Settings) -> Res {
    state.mutate(&app, |c, now| c.update_settings(&Local, now, settings))
}

#[tauri::command]
fn complete_onboarding(app: AppHandle, state: State<App>, settings: Settings) -> Res {
    state.mutate(&app, |c, now| c.complete_onboarding(&Local, now, settings))
}

#[tauri::command]
fn snooze(app: AppHandle, state: State<App>, minutes: u32) -> Res {
    state.mutate(&app, |c, now| c.snooze(&Local, now, minutes))
}

#[tauri::command]
fn pause_today(app: AppHandle, state: State<App>) -> Res {
    state.mutate(&app, |c, now| c.pause_today(&Local, now))
}

#[tauri::command]
fn resume_reminders(app: AppHandle, state: State<App>) -> Res {
    state.mutate(&app, |c, now| c.resume(now))
}

#[tauri::command]
async fn test_notification(app: AppHandle) -> Res {
    let state = app.state::<App>();
    let s = state.lock().data.settings.clone();
    let body = voice::line(&s, "reminder", state.now() as u64 / 1000, None);
    let label = format!("log {}", voice::format_ml(tray::amounts(s.unit)[1], s.unit));
    state.notify("test", &format!("{} · test notification", s.pet_name.trim()), &body, Some(&label));
    Ok(publish(&app))
}

#[tauri::command]
fn set_autostart(app: AppHandle, state: State<App>, enabled: bool) -> Res {
    let al = app.autolaunch();
    let r = if enabled { al.enable() } else { al.disable() };
    state.refresh_startup(&app);
    r.map_err(|e| format!("could not change launch on sign-in: {e}"))?;
    Ok(publish(&app))
}

#[tauri::command]
fn confirm_tray(app: AppHandle, state: State<App>, works: bool) -> Res {
    state.mutate(&app, |c, _| c.confirm_tray(works))
}

fn save_dialog(app: &AppHandle, name: &str, ext: &str, label: &str) -> Option<std::path::PathBuf> {
    let path = app.dialog().file().set_file_name(name).add_filter(label, &[ext]).blocking_save_file().and_then(|p| p.into_path().ok())?;
    // The filter is only advisory in some dialogs; always write the expected type.
    Some(if path.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext)) { path } else { path.with_extension(ext) })
}

#[tauri::command]
async fn export_json(app: AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<App>();
    let json = state.lock().export_json(state.now());
    let name = format!("hydration-sys-{}.json", chrono::Local::now().format("%Y-%m-%d"));
    let Some(path) = save_dialog(&app, &name, "json", "JSON") else { return Ok(None) };
    std::fs::write(&path, json).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

/// Saves text the UI generated (the git-log export). The path always comes
/// from the native save dialog, never from the webview.
#[tauri::command]
async fn export_text(app: AppHandle, content: String) -> Result<Option<String>, String> {
    if content.len() > 50 * 1024 * 1024 {
        return Err("export is too large".into());
    }
    let name = format!("hydration-log-{}.txt", chrono::Local::now().format("%Y-%m-%d"));
    let Some(path) = save_dialog(&app, &name, "txt", "Text") else { return Ok(None) };
    std::fs::write(&path, content).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
async fn import_pick(app: AppHandle) -> Result<Option<Snapshot>, String> {
    let picked = app.dialog().file().add_filter("hydration.sys export", &["json"]).blocking_pick_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let meta = std::fs::metadata(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err("pick a regular .json file".into());
    }
    let mut text = String::new();
    use std::io::Read;
    std::fs::File::open(&path)
        .and_then(|f| f.take(MAX_IMPORT_BYTES + 1).read_to_string(&mut text))
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if text.len() as u64 > MAX_IMPORT_BYTES {
        return Err("that file is too large to be a hydration.sys export".into());
    }
    let state = app.state::<App>();
    let now = state.now();
    state.lock().stage_import(&text, now)?;
    Ok(Some(publish(&app)))
}

#[tauri::command]
fn import_confirm(app: AppHandle, state: State<App>) -> Res {
    state.mutate(&app, |c, now| c.confirm_import(now).map(|_| ()))
}

#[tauri::command]
fn import_cancel(app: AppHandle, state: State<App>) -> Res {
    state.mutate(&app, |c, _| {
        c.cancel_import();
        Ok(())
    })
}

#[tauri::command]
fn reset_all(app: AppHandle, state: State<App>, confirm: String) -> Res {
    if confirm.trim() != "reset" {
        return Err("type reset to confirm".into());
    }
    state.mutate(&app, |c, now| c.reset_all(now))
}

#[tauri::command]
fn mark_boot_shown(app: AppHandle, state: State<App>) -> Res {
    state.mutate(&app, |c, now| c.mark_boot_shown(&Local, now))
}

#[tauri::command]
fn dismiss_notice(app: AppHandle, state: State<App>) -> Res {
    state.mutate(&app, |c, _| {
        c.dismiss_notice();
        Ok(())
    })
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    hide_main(&app);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------- startup

fn data_dir(app: &AppHandle) -> std::path::PathBuf {
    if let Some(dir) = std::env::var_os("HYDRATION_SYS_DATA_DIR").map(std::path::PathBuf::from).filter(|p| p.is_absolute()) {
        return dir;
    }
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("hydration-sys"))
}

pub fn run() {
    let autostarted = std::env::args().any(|a| a == AUTOSTART_FLAG);
    let clock_offset_ms = std::env::var("HYDRATION_SYS_CLOCK_OFFSET_MIN").ok().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0) * 60_000;

    let mut builder = tauri::Builder::default()
        // Must be first: a second launch hands its args to this process and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == AUTOSTART_FLAG) {
                return; // duplicate login launch: stay as we are
            }
            show_main(app, None);
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_FLAG])))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init());
    #[cfg(windows)]
    {
        builder = builder.plugin(tauri_plugin_notification::init());
    }

    builder = builder
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            log_drink,
            undo_last,
            delete_entry,
            update_settings,
            complete_onboarding,
            snooze,
            pause_today,
            resume_reminders,
            test_notification,
            set_autostart,
            confirm_tray,
            export_json,
            export_text,
            import_pick,
            import_confirm,
            import_cancel,
            reset_all,
            mark_boot_shown,
            dismiss_notice,
            hide_window,
            quit_app,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let dir = data_dir(&handle);
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) + clock_offset_ms;
            let mut core = Core::open(Store::new(dir.clone()), now);
            if core.roll_day(&Local, now) {
                core.save();
            }
            if autostarted {
                core.data.runtime.last_autostart_ts = Some(now);
                core.save();
            }

            let icon_path = dir.join("icon.png");
            if !icon_path.exists() {
                let _ = std::fs::write(&icon_path, include_bytes!("../icons/128x128@2x.png"));
            }
            #[cfg(target_os = "linux")]
            let notifier = {
                let h = handle.clone();
                Notifier::new(icon_path.display().to_string(), move |action, token| {
                    let h2 = h.clone();
                    let _ = h.run_on_main_thread(move || match action {
                        Action::Open => show_main(&h2, token),
                        Action::Log250 => tray_log(&h2, 1),
                    });
                })
            };
            #[cfg(windows)]
            let notifier = Notifier::new(handle.clone(), |_: Action, _: Option<String>| {});
            #[cfg(not(any(target_os = "linux", windows)))]
            let notifier = Notifier::new(String::new(), |_: Action, _: Option<String>| {});

            app.manage(App {
                core: Mutex::new(core),
                wake: Condvar::new(),
                clock_offset_ms,
                autostarted,
                notifier,
                startup: Mutex::new(StartupStatus::default()),
                theme: Mutex::new((None, None)),
                tray: Mutex::new(None),
                tray_error: Mutex::new(None),
                tray_key: Mutex::new(String::new()),
                visible: AtomicBool::new(false),
                seq: AtomicU64::new(1),
            });
            let state = handle.state::<App>();
            state.refresh_startup(&handle);

            let snap = state.snapshot();
            match tray::Tray::build(&handle, &snap) {
                Ok(t) => *lk(&state.tray) = Some(t),
                Err(e) => *lk(&state.tray_error) = Some(e.to_string()),
            }

            let s = &snap.core.settings;
            let stay_hidden = autostarted && s.close_to_tray && s.tray_verified && lk(&state.tray).is_some();
            if let Some(w) = handle.get_webview_window("main") {
                if !stay_hidden {
                    state.visible.store(true, Ordering::SeqCst);
                    let _ = w.show();
                    if !autostarted {
                        let _ = w.set_focus();
                    }
                }
            }

            let h = handle.clone();
            std::thread::Builder::new().name("scheduler".into()).spawn(move || supervise_scheduler(h))?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let app = window.app_handle();
                let state = app.state::<App>();
                let s = state.lock().data.settings.clone();
                let tray_ok = lk(&state.tray).is_some();
                if s.close_to_tray && s.tray_verified && tray_ok {
                    api.prevent_close();
                    hide_main(app);
                } else {
                    // No verified way back: closing quits for real.
                    app.exit(0);
                }
            }
            WindowEvent::Focused(true) => {
                publish(window.app_handle());
            }
            _ => {}
        });

    builder
        .build(tauri::generate_context!())
        .expect("error while building hydration.sys")
        // Every change is saved when it happens, so exiting needs no flush.
        .run(|_, _| {});
}
