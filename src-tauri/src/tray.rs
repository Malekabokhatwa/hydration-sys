//! Tray icon and menu. On Linux the menu is the only reliable interaction
//! (StatusNotifierItem hosts often don't forward clicks), so everything the
//! tray can do is a menu item.

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::core::hunger::{Pet, Stage};
use crate::core::model::Unit;
use crate::core::voice::format_ml;
use crate::Snapshot;

pub struct Tray {
    icon: TrayIcon<Wry>,
    status: MenuItem<Wry>,
    progress: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    logs: [MenuItem<Wry>; 3],
    pause: CheckMenuItem<Wry>,
    resume: MenuItem<Wry>,
    last_icon: std::sync::Mutex<&'static str>,
}

pub const AMOUNTS_ML: [u32; 3] = [150, 250, 500];
pub const AMOUNTS_OZ_ML: [u32; 3] = [148, 237, 473];

pub fn amounts(unit: Unit) -> [u32; 3] {
    match unit {
        Unit::Ml => AMOUNTS_ML,
        Unit::Oz => AMOUNTS_OZ_ML,
    }
}

fn icon_bytes(name: &str) -> &'static [u8] {
    match name {
        "thirsty" => include_bytes!("../icons/tray-thirsty.png"),
        "hungry" => include_bytes!("../icons/tray-hungry.png"),
        "goal" => include_bytes!("../icons/tray-goal.png"),
        _ => include_bytes!("../icons/tray-fed.png"),
    }
}

fn icon_name(s: &Snapshot) -> &'static str {
    let h = &s.core.hunger;
    if h.goal_met {
        "goal"
    } else {
        match h.stage {
            Stage::Fed => "fed",
            Stage::Peckish => "thirsty",
            Stage::Hungry | Stage::VeryHungry => "hungry",
        }
    }
}

fn status_text(s: &Snapshot) -> String {
    let set = &s.core.settings;
    let name = set.pet_name.trim();
    let mood = match s.core.hunger.pet {
        Pet::Idle => "fed",
        Pet::Happy => "happy",
        Pet::Thirsty => "a little thirsty",
        Pet::Hungry => "hungry",
        Pet::VeryHungry => "very hungry",
        Pet::Recovering => "recovering",
        Pet::Goal => "goal complete",
        Pet::Sleeping => "asleep (outside active hours)",
    };
    format!("{name}: {mood}")
}

fn progress_text(s: &Snapshot) -> String {
    let u = s.core.settings.unit;
    let pct = (s.core.today_total as f64 / s.core.today_goal.max(1) as f64 * 100.0).min(100.0).round();
    format!("{} / {} today ({pct}%)", format_ml(s.core.today_total, u), format_ml(s.core.today_goal, u))
}

impl Tray {
    pub fn build(app: &AppHandle, s: &Snapshot) -> tauri::Result<Tray> {
        let status = MenuItem::with_id(app, "status", status_text(s), false, None::<&str>)?;
        let progress = MenuItem::with_id(app, "progress", progress_text(s), false, None::<&str>)?;
        let toggle = MenuItem::with_id(app, "toggle", "show hydration.sys", true, None::<&str>)?;
        let unit = s.core.settings.unit;
        let a = amounts(unit);
        let logs = [
            MenuItem::with_id(app, "log-0", format!("log {}", format_ml(a[0], unit)), true, None::<&str>)?,
            MenuItem::with_id(app, "log-1", format!("log {}", format_ml(a[1], unit)), true, None::<&str>)?,
            MenuItem::with_id(app, "log-2", format!("log {}", format_ml(a[2], unit)), true, None::<&str>)?,
        ];
        let snooze = Submenu::with_id_and_items(
            app,
            "snooze",
            "snooze reminders",
            true,
            &[
                &MenuItem::with_id(app, "snooze-15", "15 minutes", true, None::<&str>)?,
                &MenuItem::with_id(app, "snooze-30", "30 minutes", true, None::<&str>)?,
                &MenuItem::with_id(app, "snooze-60", "1 hour", true, None::<&str>)?,
            ],
        )?;
        let pause = CheckMenuItem::with_id(app, "pause", "pause reminders today", true, s.core.reminders.paused_today, None::<&str>)?;
        let resume = MenuItem::with_id(app, "resume", "resume reminders", s.core.reminders.paused_today || s.core.reminders.snooze_until.is_some(), None::<&str>)?;
        let settings = MenuItem::with_id(app, "settings", "settings…", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "quit hydration.sys", true, None::<&str>)?;
        let sep = || PredefinedMenuItem::separator(app);
        let menu = Menu::with_items(
            app,
            &[&status, &progress, &sep()?, &toggle, &sep()?, &logs[0], &logs[1], &logs[2], &sep()?, &snooze, &pause, &resume, &sep()?, &settings, &quit],
        )?;

        let first = icon_name(s);
        let icon = TrayIconBuilder::with_id("main")
            .icon(Image::from_bytes(icon_bytes(first))?)
            .tooltip(format!("hydration.sys · {}", progress_text(s)))
            .menu(&menu)
            .show_menu_on_left_click(cfg!(target_os = "linux"))
            .on_menu_event(|app, ev| crate::on_tray_menu(app, ev.id().as_ref()))
            .on_tray_icon_event(|tray, ev| {
                // Windows: left click toggles the window, right click opens the menu.
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                    crate::toggle_main(tray.app_handle());
                }
            })
            .build(app)?;

        Ok(Tray { icon, status, progress, toggle, logs, pause, resume, last_icon: std::sync::Mutex::new(first) })
    }

    /// Main thread only (see `publish` in lib.rs).
    pub fn update(&self, visible: bool, s: &Snapshot) {
        let _ = self.status.set_text(status_text(s));
        let _ = self.progress.set_text(progress_text(s));
        let _ = self.icon.set_tooltip(Some(format!("hydration.sys · {}", progress_text(s))));
        let unit = s.core.settings.unit;
        for (item, ml) in self.logs.iter().zip(amounts(unit)) {
            let _ = item.set_text(format!("log {}", format_ml(ml, unit)));
        }
        let _ = self.pause.set_checked(s.core.reminders.paused_today);
        let _ = self.resume.set_enabled(s.core.reminders.paused_today || s.core.reminders.snooze_until.is_some());
        let _ = self.toggle.set_text(if visible { "hide hydration.sys" } else { "show hydration.sys" });
        let name = icon_name(s);
        let mut last = self.last_icon.lock().unwrap();
        if *last != name {
            if let Ok(img) = Image::from_bytes(icon_bytes(name)) {
                let _ = self.icon.set_icon(Some(img));
            }
            *last = name;
        }
    }
}
