//! Facts about the desktop that the UI reports honestly: how launch-on-login
//! is wired, whether this session honors it, and the Omarchy theme palette.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    /// The Tauri autostart plugin's own entry exists (XDG .desktop / registry).
    pub plugin_enabled: bool,
    /// Linux: the session runs XDG autostart entries (systemd's
    /// xdg-desktop-autostart.target is active, as with uwsm). None = unknown.
    pub session_honors_xdg: Option<bool>,
    /// Linux: a manual Hyprland startup line mentions hydration-sys.
    pub manual_hyprland: bool,
    /// Where the manual snippet would go and what to put there.
    pub hyprland_config: Option<String>,
    pub hyprland_lua: bool,
    pub hyprland_snippet: Option<String>,
    pub exe: String,
    pub error: Option<String>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn config_home() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).or_else(|| home().map(|h| h.join(".config")))
}

pub fn exe_path() -> String {
    std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "hydration-sys".into())
}

#[cfg(target_os = "linux")]
pub fn startup_status(plugin_enabled: Result<bool, String>) -> StartupStatus {
    let exe = exe_path();
    let mut st = StartupStatus { exe: exe.clone(), ..Default::default() };
    match plugin_enabled {
        Ok(v) => st.plugin_enabled = v,
        Err(e) => st.error = Some(e),
    }
    st.session_honors_xdg = std::process::Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", "xdg-desktop-autostart.target"])
        .status()
        .ok()
        .map(|s| s.success());
    if let Some(hypr) = config_home().map(|c| c.join("hypr")) {
        let lua = hypr.join("autostart.lua");
        let legacy = hypr.join("autostart.conf");
        let main_lua = hypr.join("hyprland.lua");
        let (file, is_lua) = if lua.exists() || main_lua.exists() { (lua, true) } else { (legacy, false) };
        st.hyprland_lua = is_lua;
        st.manual_hyprland = std::fs::read_to_string(&file).map(|t| t.lines().any(|l| !l.trim_start().starts_with("--") && !l.trim_start().starts_with('#') && l.contains("hydration-sys"))).unwrap_or(false);
        st.hyprland_snippet = Some(if is_lua {
            format!("o.launch_on_start(\"{exe} --autostarted\")")
        } else {
            format!("exec-once = {exe} --autostarted")
        });
        st.hyprland_config = Some(file.display().to_string());
    }
    st
}

#[cfg(not(target_os = "linux"))]
pub fn startup_status(plugin_enabled: Result<bool, String>) -> StartupStatus {
    let mut st = StartupStatus { exe: exe_path(), ..Default::default() };
    match plugin_enabled {
        Ok(v) => st.plugin_enabled = v,
        Err(e) => st.error = Some(e),
    }
    st
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmarchyTheme {
    pub name: Option<String>,
    pub colors: BTreeMap<String, String>,
}

/// Reads `~/.local/state/omarchy/current/theme/colors.toml` (flat `key = "#hex"`
/// lines). Only well-formed hex colors are passed to the webview.
pub fn omarchy_theme() -> Option<OmarchyTheme> {
    let dir = home()?.join(".local/state/omarchy/current");
    let text = std::fs::read_to_string(dir.join("theme/colors.toml")).ok()?;
    let mut colors = BTreeMap::new();
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let k = k.trim();
        let v = v.trim().trim_matches('"');
        let valid_key = !k.is_empty() && k.len() <= 32 && k.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
        let valid_val = v.len() == 7 && v.starts_with('#') && v[1..].bytes().all(|b| b.is_ascii_hexdigit());
        if valid_key && valid_val {
            colors.insert(k.to_string(), v.to_ascii_lowercase());
        } else if k == "mode" && (v == "dark" || v == "light") {
            colors.insert("mode".into(), v.into());
        }
    }
    if !colors.contains_key("background") || !colors.contains_key("foreground") {
        return None;
    }
    let name = std::fs::read_to_string(dir.join("theme.name")).ok().map(|s| s.trim().chars().take(40).collect());
    Some(OmarchyTheme { name, colors })
}

/// Modification time of the theme file, to notice `omarchy theme set`.
pub fn omarchy_theme_stamp() -> Option<std::time::SystemTime> {
    let p = home()?.join(".local/state/omarchy/current/theme/colors.toml");
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// A launcher entry exists, so re-running the app from the launcher is a
/// working way back to a hidden window.
pub fn launcher_installed() -> bool {
    if cfg!(not(target_os = "linux")) {
        return true;
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(h) = home() {
        dirs.push(h.join(".local/share/applications"));
    }
    dirs.push("/usr/share/applications".into());
    dirs.push("/usr/local/share/applications".into());
    dirs.iter().any(|d| d.join("hydration-sys.desktop").exists() || d.join("hydration.sys.desktop").exists())
}
