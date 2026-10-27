//! Persisted data: drink entries, per-day goal snapshots, settings and the
//! reminder bookkeeping the scheduler needs to survive restarts.

use std::collections::{BTreeMap, HashSet};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

pub const DATA_VERSION: u32 = 1;
pub const MIN_ML: u32 = 1;
pub const MAX_ML: u32 = 2000;
pub const MIN_GOAL_ML: u32 = 250;
pub const MAX_GOAL_ML: u32 = 10_000;
pub const MAX_ENTRIES: usize = 200_000;
pub const MAX_PET_NAME: usize = 24;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    /// Unix time in milliseconds.
    pub ts: i64,
    /// Local calendar date (YYYY-MM-DD) at the moment of logging. Never
    /// recomputed, so travel or DST never moves a drink to another day.
    pub date: String,
    pub ml: u32,
    /// UTC offset in minutes at logging time, for display after travel.
    #[serde(default)]
    pub offset_min: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Ml,
    Oz,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Omarchy,
    Phosphor,
    Amber,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Motion {
    System,
    Reduce,
    Full,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub pet_name: String,
    /// Goal for days that have not started yet. Today's goal is frozen in
    /// `Data::day_goals`, so a change here applies from the next local day.
    pub goal_ml: u32,
    pub unit: Unit,
    /// Minutes after local midnight. `active_end` may be 1440 (midnight).
    pub active_start: u32,
    pub active_end: u32,
    pub reminders_enabled: bool,
    pub reminder_interval_min: u32,
    pub min_gap_min: u32,
    pub daily_max: u32,
    pub quiet_enabled: bool,
    pub quiet_start: u32,
    pub quiet_end: u32,
    pub peckish_min: u32,
    pub hungry_min: u32,
    pub very_hungry_min: u32,
    pub close_to_tray: bool,
    /// The user confirmed they can see and use the tray icon.
    pub tray_verified: bool,
    pub theme: Theme,
    pub chill: bool,
    pub no_jokes: bool,
    pub motion: Motion,
    pub onboarded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            pet_name: "byte".into(),
            goal_ml: 2000,
            unit: Unit::Ml,
            active_start: 9 * 60,
            active_end: 21 * 60,
            reminders_enabled: true,
            reminder_interval_min: 75,
            min_gap_min: 45,
            daily_max: 8,
            quiet_enabled: false,
            quiet_start: 12 * 60,
            quiet_end: 13 * 60,
            peckish_min: 90,
            hungry_min: 150,
            very_hungry_min: 240,
            close_to_tray: false,
            tray_verified: false,
            theme: if cfg!(target_os = "linux") { Theme::Omarchy } else { Theme::Phosphor },
            chill: false,
            no_jokes: false,
            motion: Motion::System,
            onboarded: false,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        let name = self.pet_name.trim();
        if name.is_empty() || name.chars().count() > MAX_PET_NAME {
            return Err(format!("pet name must be 1-{MAX_PET_NAME} characters"));
        }
        if name.chars().any(|c| c.is_control()) {
            return Err("pet name cannot contain control characters".into());
        }
        if !(MIN_GOAL_ML..=MAX_GOAL_ML).contains(&self.goal_ml) {
            return Err(format!("daily goal must be {MIN_GOAL_ML}-{MAX_GOAL_ML} mL"));
        }
        if self.active_start >= self.active_end || self.active_end > 1440 {
            return Err("active hours must start before they end (same day)".into());
        }
        if self.active_end - self.active_start < 60 {
            return Err("active hours must span at least one hour".into());
        }
        if !(15..=480).contains(&self.reminder_interval_min) {
            return Err("reminder interval must be 15-480 minutes".into());
        }
        if !(10..=480).contains(&self.min_gap_min) || self.min_gap_min > self.reminder_interval_min {
            return Err("minimum gap must be 10-480 minutes and not above the interval".into());
        }
        if !(1..=24).contains(&self.daily_max) {
            return Err("daily maximum must be 1-24 reminders".into());
        }
        if self.quiet_start >= 1440 || self.quiet_end > 1440 || self.quiet_start == self.quiet_end {
            return Err("quiet hours need a distinct start and end".into());
        }
        if !(self.peckish_min >= 15 && self.peckish_min < self.hungry_min && self.hungry_min < self.very_hungry_min && self.very_hungry_min <= 720) {
            return Err("hunger thresholds must increase: peckish < hungry < very hungry (15-720 min)".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Runtime {
    pub last_reminder_ts: Option<i64>,
    /// Local date the `sent_count` belongs to.
    pub sent_date: Option<String>,
    pub sent_count: u32,
    pub snooze_until: Option<i64>,
    /// Local date on which reminders are paused for the rest of the day.
    pub paused_date: Option<String>,
    /// Intervals today during which hunger is frozen (snoozes and pauses).
    pub freezes: Vec<(i64, i64)>,
    pub freeze_date: Option<String>,
    /// Last local date the morning boot animation ran on manual open.
    pub last_boot_date: Option<String>,
    /// Last time the app was started by the login autostart entry.
    pub last_autostart_ts: Option<i64>,
    pub last_notify: Option<NotifyRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyRecord {
    pub ts: i64,
    pub ok: bool,
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Data {
    pub version: u32,
    #[serde(default)]
    pub entries: Vec<Entry>,
    /// Goal in effect per local date, frozen the first time the day is seen.
    #[serde(default)]
    pub day_goals: BTreeMap<String, u32>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub runtime: Runtime,
}

impl Default for Data {
    fn default() -> Self {
        Data {
            version: DATA_VERSION,
            entries: Vec::new(),
            day_goals: BTreeMap::new(),
            settings: Settings::default(),
            runtime: Runtime::default(),
        }
    }
}

pub fn parse_date(s: &str) -> Option<NaiveDate> {
    // Exact zero-padded form only, so string ordering equals date ordering.
    if s.len() != 10 {
        return None;
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn validate_amount(ml: u32) -> Result<(), String> {
    if (MIN_ML..=MAX_ML).contains(&ml) {
        Ok(())
    } else {
        Err(format!("amount must be a whole number from {MIN_ML} to {MAX_ML} mL"))
    }
}

const MIN_TS: i64 = 946_684_800_000; // 2000-01-01

/// What is wrong with one entry, ignoring how far in the future it is.
fn entry_problem(e: &Entry) -> Option<String> {
    if !valid_id(&e.id) {
        return Some("invalid id".into());
    }
    if let Err(m) = validate_amount(e.ml) {
        return Some(m);
    }
    if e.ts < MIN_TS {
        return Some("timestamp out of range".into());
    }
    let Some(d) = parse_date(&e.date) else {
        return Some("invalid date".into());
    };
    // The stored local date must be within a day of the UTC date of ts
    // (any real timezone is within +-14h).
    if let Some(u) = chrono::DateTime::from_timestamp_millis(e.ts).map(|t| t.date_naive()) {
        if (d - u).num_days().abs() > 1 {
            return Some("date does not match timestamp".into());
        }
    } else {
        return Some("timestamp out of range".into());
    }
    if !(-16 * 60..=16 * 60).contains(&e.offset_min) {
        return Some("invalid utc offset".into());
    }
    None
}

fn goal_ok(date: &str, goal: u32) -> bool {
    parse_date(date).is_some() && (MIN_GOAL_ML..=MAX_GOAL_ML).contains(&goal)
}

/// Strict validation for imports: any problem rejects the whole file, and
/// timestamps more than two days past `now_ms` are refused.
pub fn validate_data(data: &Data, now_ms: i64) -> Result<(), String> {
    if data.version != DATA_VERSION {
        return Err(format!("unsupported data version {} (expected {DATA_VERSION})", data.version));
    }
    if data.entries.len() > MAX_ENTRIES {
        return Err(format!("too many entries ({})", data.entries.len()));
    }
    data.settings.validate().map_err(|e| format!("settings: {e}"))?;
    let max_ts = now_ms + 2 * 86_400_000;
    let mut seen = HashSet::with_capacity(data.entries.len());
    for (i, e) in data.entries.iter().enumerate() {
        let at = || format!("entry {} ({})", i + 1, e.id);
        if let Some(p) = entry_problem(e) {
            return Err(format!("{}: {p}", at()));
        }
        if !seen.insert(e.id.as_str()) {
            return Err(format!("{}: duplicate id", at()));
        }
        if e.ts > max_ts {
            return Err(format!("{}: timestamp is in the future", at()));
        }
    }
    for (date, goal) in &data.day_goals {
        if !goal_ok(date, *goal) {
            return Err(format!("day goal {date}: invalid"));
        }
    }
    Ok(())
}

/// Load-time repair for our own data file: drops only the rows that are
/// invalid instead of rejecting the whole history (a wrong system clock or a
/// single bad row must not cost years of entries). Returns how many items
/// were dropped or reset.
pub fn sanitize(data: &mut Data) -> usize {
    let mut dropped = 0;
    let mut seen = HashSet::with_capacity(data.entries.len());
    data.entries.retain(|e| {
        let keep = entry_problem(e).is_none() && seen.insert(e.id.clone());
        dropped += usize::from(!keep);
        keep
    });
    if data.entries.len() > MAX_ENTRIES {
        dropped += data.entries.len() - MAX_ENTRIES;
        data.entries.sort_by_key(|e| e.ts);
        data.entries.drain(..data.entries.len() - MAX_ENTRIES);
    }
    let before = data.day_goals.len();
    data.day_goals.retain(|d, g| goal_ok(d, *g));
    dropped += before - data.day_goals.len();
    if data.settings.validate().is_err() {
        let onboarded = data.settings.onboarded;
        data.settings = Settings { onboarded, ..Settings::default() };
        dropped += 1;
    }
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, ts: i64, date: &str, ml: u32) -> Entry {
        Entry { id: id.into(), ts, date: date.into(), ml, offset_min: 0 }
    }

    const NOW: i64 = 1_793_000_000_000; // 2026-10-26

    #[test]
    fn amount_bounds() {
        assert!(validate_amount(0).is_err());
        assert!(validate_amount(1).is_ok());
        assert!(validate_amount(2000).is_ok());
        assert!(validate_amount(2001).is_err());
    }

    #[test]
    fn default_settings_are_valid() {
        Settings::default().validate().unwrap();
    }

    #[test]
    fn rejects_bad_settings() {
        let mut s = Settings::default();
        s.active_start = 22 * 60;
        assert!(s.validate().is_err());
        let mut s = Settings::default();
        s.hungry_min = 80;
        assert!(s.validate().is_err());
        let mut s = Settings::default();
        s.pet_name = "a\u{7}".into();
        assert!(s.validate().is_err());
        let mut s = Settings::default();
        s.min_gap_min = 200;
        assert!(s.validate().is_err());
    }

    #[test]
    fn data_validation() {
        let mut d = Data::default();
        d.entries.push(entry("a1", NOW, "2026-10-26", 250));
        validate_data(&d, NOW).unwrap();

        let mut dup = d.clone();
        dup.entries.push(entry("a1", NOW, "2026-10-26", 250));
        assert!(validate_data(&dup, NOW).unwrap_err().contains("duplicate"));

        let mut bad = d.clone();
        bad.entries[0].date = "2026-1-26".into();
        assert!(validate_data(&bad, NOW).is_err());

        let mut far = d.clone();
        far.entries[0].date = "2026-10-20".into();
        assert!(validate_data(&far, NOW).unwrap_err().contains("match"));

        let mut future = d.clone();
        future.entries[0].ts = NOW + 10 * 86_400_000;
        future.entries[0].date = "2026-11-05".into();
        assert!(validate_data(&future, NOW).unwrap_err().contains("future"));
        // ...but loading our own file keeps it (the clock may be wrong).
        let mut f2 = future.clone();
        assert_eq!(sanitize(&mut f2), 0);

        let mut v = d.clone();
        v.version = 2;
        assert!(validate_data(&v, NOW).is_err());

        let mut id = d.clone();
        id.entries[0].id = "<script>".into();
        assert!(validate_data(&id, NOW).is_err());

        let mut goal = d;
        goal.day_goals.insert("2026-10-26".into(), 99_999);
        assert!(validate_data(&goal, NOW).is_err());
    }

    #[test]
    fn sanitize_drops_only_bad_rows() {
        let mut d = Data::default();
        d.entries.push(entry("ok1", NOW, "2026-10-26", 250));
        d.entries.push(entry("bad", NOW, "2026-10-26", 5000));
        d.entries.push(entry("ok1", NOW, "2026-10-26", 300)); // duplicate id
        d.entries.push(entry("ok2", NOW, "2026-10-26", 500));
        d.day_goals.insert("nope".into(), 2000);
        d.settings.goal_ml = 1;
        d.settings.onboarded = true;
        assert_eq!(sanitize(&mut d), 4);
        assert_eq!(d.entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["ok1", "ok2"]);
        assert!(d.day_goals.is_empty());
        assert!(d.settings.onboarded && d.settings.goal_ml == 2000);
    }

    #[test]
    fn unknown_entry_fields_rejected() {
        let json = r#"{"version":1,"entries":[{"id":"a","ts":1793000000000,"date":"2026-10-26","ml":250,"evil":1}]}"#;
        assert!(serde_json::from_str::<Data>(json).is_err());
    }
}
