//! Native notifications.
//!
//! Linux: talks to org.freedesktop.Notifications on the session bus directly
//! (the same interface the Tauri plugin uses through notify-rust), so we can
//! replace the previous reminder instead of stacking them, read the server's
//! capabilities, and react to a click ("default" action) by opening the app.
//! Desktop DND is the server's business; we never bypass it.
//!
//! Windows: the official Tauri notification plugin. Toast clicks and action
//! buttons are not wired on desktop, so the tray is the fast path there.

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifierInfo {
    pub available: bool,
    pub server: Option<String>,
    pub capabilities: Vec<String>,
    pub actions: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Open,
    Log250,
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{Action, NotifierInfo};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use zbus::blocking::{connection, Connection, MessageIterator};
    use zbus::zvariant::Value;
    use zbus::MatchRule;

    const DEST: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";

    pub struct Notifier {
        conn: Option<Connection>,
        /// Re-probed whenever a send fails, so a notification daemon that
        /// starts (or restarts) after us is picked up.
        info: Mutex<NotifierInfo>,
        /// Id of our most recent notification; new ones replace it.
        last_id: Arc<AtomicU32>,
        icon: String,
    }

    /// Servers that advertise body-markup would render tags from a pet name.
    fn escape(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
    }

    impl Notifier {
        pub fn new(icon: String, on_action: impl Fn(Action, Option<String>) + Send + 'static) -> Notifier {
            let last_id = Arc::new(AtomicU32::new(0));
            // Short timeouts: a hung daemon must never stall startup or a click.
            let conn = connection::Builder::session().and_then(|b| b.method_timeout(Duration::from_secs(3)).build());
            let n = match conn {
                Ok(c) => {
                    spawn_listener(c.clone(), last_id.clone(), on_action);
                    Notifier { conn: Some(c), info: Mutex::new(NotifierInfo::default()), last_id, icon }
                }
                Err(e) => Notifier {
                    conn: None,
                    info: Mutex::new(NotifierInfo { error: Some(format!("no session bus: {e}")), ..Default::default() }),
                    last_id,
                    icon,
                },
            };
            n.probe();
            n
        }

        fn probe(&self) -> NotifierInfo {
            let Some(conn) = &self.conn else { return self.info() };
            let mut info = NotifierInfo::default();
            match conn.call_method(Some(DEST), PATH, Some(DEST), "GetServerInformation", &()) {
                Ok(reply) => {
                    if let Ok((name, vendor, version, _spec)) = reply.body().deserialize::<(String, String, String, String)>() {
                        let who = if vendor.is_empty() || vendor == name { name } else { format!("{name} ({vendor})") };
                        info.server = Some(format!("{who} {version}").trim().to_string());
                    }
                    info.available = true;
                }
                Err(e) => info.error = Some(format!("no notification service on the session bus: {e}")),
            }
            if info.available {
                if let Ok(reply) = conn.call_method(Some(DEST), PATH, Some(DEST), "GetCapabilities", &()) {
                    info.capabilities = reply.body().deserialize::<Vec<String>>().unwrap_or_default();
                }
                info.actions = info.capabilities.iter().any(|c| c == "actions");
            }
            *self.info.lock().unwrap_or_else(|p| p.into_inner()) = info.clone();
            info
        }

        pub fn info(&self) -> NotifierInfo {
            self.info.lock().unwrap_or_else(|p| p.into_inner()).clone()
        }

        /// `log_label` is the text of the quick-log action button, if any.
        pub fn send(&self, summary: &str, body: &str, log_label: Option<&str>) -> Result<u32, String> {
            let Some(conn) = &self.conn else {
                return Err(self.info().error.unwrap_or_else(|| "no session bus".into()));
            };
            let mut info = self.info();
            if !info.available {
                info = self.probe();
                if !info.available {
                    return Err(info.error.unwrap_or_else(|| "notification service unavailable".into()));
                }
            }
            let markup = info.capabilities.iter().any(|c| c == "body-markup");
            let body = if markup { escape(body) } else { body.to_string() };
            let mut actions: Vec<&str> = Vec::new();
            if let (true, Some(label)) = (info.actions, log_label) {
                actions.extend(["default", "open hydration.sys", "log-250", label]);
            }
            let mut hints: HashMap<&str, Value> = HashMap::new();
            hints.insert("desktop-entry", Value::from("hydration-sys"));
            hints.insert("urgency", Value::U8(1));
            hints.insert("category", Value::from("presence"));
            let replaces = self.last_id.load(Ordering::SeqCst);
            let args = ("hydration.sys", replaces, self.icon.as_str(), summary, body.as_str(), actions, hints, -1i32);
            let reply = match conn.call_method(Some(DEST), PATH, Some(DEST), "Notify", &args) {
                Ok(r) => r,
                Err(e) => {
                    // The daemon may have restarted: re-probe so the status is honest.
                    self.probe();
                    return Err(format!("Notify failed: {e}"));
                }
            };
            let id: u32 = reply.body().deserialize().map_err(|e| format!("bad reply: {e}"))?;
            self.last_id.store(id, Ordering::SeqCst);
            Ok(id)
        }
    }

    fn spawn_listener(conn: Connection, last_id: Arc<AtomicU32>, on_action: impl Fn(Action, Option<String>) + Send + 'static) {
        std::thread::Builder::new()
            .name("notify-signals".into())
            .spawn(move || {
                let rule = match MatchRule::builder().msg_type(zbus::message::Type::Signal).interface(DEST).and_then(|b| b.path(PATH)) {
                    Ok(b) => b.build(),
                    Err(_) => return,
                };
                let Ok(iter) = MessageIterator::for_match_rule(rule, &conn, Some(32)) else { return };
                let mut token: Option<String> = None;
                for msg in iter.flatten() {
                    let header = msg.header();
                    let Some(member) = header.member() else { continue };
                    match member.as_str() {
                        // Sent just before ActionInvoked; lets us take focus legitimately.
                        "ActivationToken" => {
                            if let Ok((id, t)) = msg.body().deserialize::<(u32, String)>() {
                                if id == last_id.load(Ordering::SeqCst) {
                                    token = Some(t);
                                }
                            }
                        }
                        "ActionInvoked" => {
                            if let Ok((id, key)) = msg.body().deserialize::<(u32, String)>() {
                                if id == 0 || id != last_id.load(Ordering::SeqCst) {
                                    continue;
                                }
                                match key.as_str() {
                                    "default" => on_action(Action::Open, token.take()),
                                    "log-250" => on_action(Action::Log250, token.take()),
                                    _ => {}
                                }
                            }
                        }
                        "NotificationClosed" => {
                            if let Ok((id, _reason)) = msg.body().deserialize::<(u32, u32)>() {
                                let _ = last_id.compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst);
                            }
                        }
                        _ => {}
                    }
                }
            })
            .ok();
    }
}

#[cfg(windows)]
mod imp {
    use super::{Action, NotifierInfo};
    use tauri::AppHandle;
    use tauri_plugin_notification::NotificationExt;

    pub struct Notifier {
        app: AppHandle,
    }

    impl Notifier {
        pub fn new(app: AppHandle, _on_action: impl Fn(Action, Option<String>) + Send + 'static) -> Notifier {
            Notifier { app }
        }

        pub fn info(&self) -> NotifierInfo {
            NotifierInfo { available: true, server: Some("Windows toast notifications".into()), capabilities: vec![], actions: false, error: None }
        }

        pub fn send(&self, summary: &str, body: &str, _log_label: Option<&str>) -> Result<u32, String> {
            self.app.notification().builder().title(summary).body(body).show().map_err(|e| e.to_string())?;
            Ok(0)
        }
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod imp {
    use super::{Action, NotifierInfo};

    pub struct Notifier;

    impl Notifier {
        pub fn new(_icon: String, _on_action: impl Fn(Action, Option<String>) + Send + 'static) -> Notifier {
            Notifier
        }
        pub fn info(&self) -> NotifierInfo {
            NotifierInfo { error: Some("notifications are not implemented on this platform".into()), ..Default::default() }
        }
        pub fn send(&self, _: &str, _: &str, _: Option<&str>) -> Result<u32, String> {
            Err("notifications are not implemented on this platform".into())
        }
    }
}

pub use imp::Notifier;
