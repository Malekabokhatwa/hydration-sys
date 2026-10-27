//! The single authoritative copy of the user's data and every mutation on it.
//! Nothing here knows about Tauri, so it is fully testable with a fixed clock
//! and timezone.

use std::collections::BTreeMap;
use std::hash::{BuildHasher, Hasher};

use chrono::{NaiveDate, TimeZone};
use serde::Serialize;

use super::hunger::{self, Hunger, HungerInput, Thresholds};
use super::model::{validate_amount, validate_data, Data, Entry, NotifyRecord, Settings};
use super::reminders::{self, Decision, ReminderInput};
use super::storage::{LoadOutcome, Store};
use super::time::{date_key, day_window, local_date, offset_minutes, quiet_intervals};

pub struct Core {
    pub data: Data,
    pub store: Store,
    pub save_error: Option<String>,
    pub notice: Option<LoadOutcome>,
    pending_import: Option<(Data, ImportPreview)>,
    /// Set by every mutation so the scheduler re-evaluates before sleeping.
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub entries: usize,
    pub days: usize,
    pub first_date: Option<String>,
    pub last_date: Option<String>,
    pub total_ml: u64,
    pub pet_name: String,
    pub current_entries: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderView {
    #[serde(flatten)]
    pub decision: Decision,
    pub sent_today: u32,
    pub last_reminder_ts: Option<i64>,
    pub snooze_until: Option<i64>,
    pub paused_today: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageView {
    pub path: String,
    pub last_save_ok: bool,
    pub last_error: Option<String>,
    pub notice: Option<LoadOutcome>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreView {
    pub now: i64,
    pub today: String,
    pub offset_min: i32,
    pub window: (i64, i64),
    pub entries: Vec<Entry>,
    pub day_goals: BTreeMap<String, u32>,
    pub settings: Settings,
    pub today_goal: u32,
    pub today_total: u32,
    pub hunger: Hunger,
    pub reminders: ReminderView,
    pub storage: StorageView,
    pub last_boot_date: Option<String>,
    pub last_notify: Option<NotifyRecord>,
    pub pending_import: Option<ImportPreview>,
}

fn random_u64() -> u64 {
    // RandomState is seeded from the OS; good enough for unique-ish ids.
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(std::process::id() as u64);
    h.finish()
}

impl Core {
    pub fn open(store: Store, now: i64) -> Core {
        let (data, outcome) = store.load(now);
        let notice = match outcome {
            LoadOutcome::Fresh | LoadOutcome::Loaded => None,
            other => Some(other),
        };
        let mut core = Core { data, store, save_error: None, notice, pending_import: None, dirty: true };
        if core.notice.is_some() {
            // Write the recovered (or fresh) state right away so the next
            // start does not hit the damaged file again.
            core.save();
        }
        core
    }

    /// Persists and records the outcome. Never claims success it didn't have.
    pub fn save(&mut self) -> bool {
        self.dirty = true;
        match self.store.save(&self.data) {
            Ok(()) => {
                self.save_error = None;
                true
            }
            Err(e) => {
                self.save_error = Some(format!("could not save to {}: {e}", self.store.path().display()));
                false
            }
        }
    }

    fn save_result(&mut self) -> Result<(), String> {
        if self.save() {
            Ok(())
        } else {
            Err(self.save_error.clone().unwrap_or_default())
        }
    }

    pub fn today<Tz: TimeZone>(&self, tz: &Tz, now: i64) -> NaiveDate {
        local_date(tz, now)
    }

    /// Day rollover housekeeping: freeze today's goal, reset per-day counters.
    /// Returns true when something changed (caller saves).
    pub fn roll_day<Tz: TimeZone>(&mut self, tz: &Tz, now: i64) -> bool {
        let today = date_key(self.today(tz, now));
        let mut changed = false;
        if !self.data.day_goals.contains_key(&today) {
            self.data.day_goals.insert(today.clone(), self.data.settings.goal_ml);
            changed = true;
        }
        let rt = &mut self.data.runtime;
        if rt.sent_date.as_deref() != Some(today.as_str()) && (rt.sent_date.is_some() || rt.sent_count != 0) {
            rt.sent_date = Some(today.clone());
            rt.sent_count = 0;
            changed = true;
        }
        if rt.paused_date.as_deref().is_some_and(|d| d != today) {
            rt.paused_date = None;
            changed = true;
        }
        if rt.freeze_date.as_deref().is_some_and(|d| d != today) {
            rt.freeze_date = None;
            rt.freezes.clear();
            changed = true;
        }
        if rt.snooze_until.is_some_and(|s| s <= now) {
            rt.snooze_until = None;
            changed = true;
        }
        changed
    }

    fn goal_for(&self, date: &str) -> u32 {
        self.data.day_goals.get(date).copied().unwrap_or(self.data.settings.goal_ml)
    }

    fn total_for(&self, date: &str) -> u32 {
        self.data.entries.iter().filter(|e| e.date == date).map(|e| e.ml).sum()
    }

    fn freezes(&self, today: &str, window_end: i64) -> Vec<(i64, i64)> {
        let rt = &self.data.runtime;
        if rt.freeze_date.as_deref() != Some(today) {
            return Vec::new();
        }
        rt.freezes.iter().map(|&(s, e)| (s, e.min(window_end))).collect()
    }

    pub fn hunger<Tz: TimeZone>(&self, tz: &Tz, now: i64) -> (Hunger, (i64, i64)) {
        let d = self.today(tz, now);
        let today = date_key(d);
        let s = &self.data.settings;
        let window = day_window(tz, d, s.active_start, s.active_end);
        let logs: Vec<i64> = self.data.entries.iter().filter(|e| e.date == today).map(|e| e.ts).collect();
        let freezes = self.freezes(&today, window.1);
        let h = hunger::compute(&HungerInput {
            now,
            today_logs: &logs,
            window,
            pauses: &freezes,
            total_ml: self.total_for(&today),
            goal_ml: self.goal_for(&today),
            thresholds: Thresholds { peckish_min: s.peckish_min, hungry_min: s.hungry_min, very_hungry_min: s.very_hungry_min },
        });
        (h, window)
    }

    pub fn decision<Tz: TimeZone>(&self, tz: &Tz, now: i64) -> Decision {
        let d = self.today(tz, now);
        let today = date_key(d);
        let s = &self.data.settings;
        let rt = &self.data.runtime;
        let window = day_window(tz, d, s.active_start, s.active_end);
        let quiet = if s.quiet_enabled { quiet_intervals(tz, d, s.quiet_start, s.quiet_end) } else { Vec::new() };
        let sent_today = if rt.sent_date.as_deref() == Some(today.as_str()) { rt.sent_count } else { 0 };
        reminders::evaluate(&ReminderInput {
            now,
            enabled: s.reminders_enabled,
            window,
            quiet: &quiet,
            last_log: self.data.entries.iter().map(|e| e.ts).filter(|&t| t <= now).max(),
            last_reminder: rt.last_reminder_ts,
            sent_today,
            daily_max: s.daily_max,
            interval_min: s.reminder_interval_min,
            min_gap_min: s.min_gap_min,
            snooze_until: rt.snooze_until,
            paused_today: rt.paused_date.as_deref() == Some(today.as_str()),
            goal_met: self.total_for(&today) >= self.goal_for(&today),
        })
    }

    pub fn record_reminder<Tz: TimeZone>(&mut self, tz: &Tz, now: i64) {
        let today = date_key(self.today(tz, now));
        let rt = &mut self.data.runtime;
        if rt.sent_date.as_deref() != Some(today.as_str()) {
            rt.sent_date = Some(today);
            rt.sent_count = 0;
        }
        rt.sent_count += 1;
        rt.last_reminder_ts = Some(now);
        self.save();
    }

    /// In memory only; persisted with the next real save.
    pub fn record_notify(&mut self, rec: NotifyRecord) {
        self.data.runtime.last_notify = Some(rec);
        self.dirty = true;
    }

    pub fn log_drink<Tz: TimeZone>(&mut self, tz: &Tz, now: i64, ml: u32) -> Result<Entry, String> {
        validate_amount(ml)?;
        self.roll_day(tz, now);
        let entry = Entry {
            id: format!("{:011x}{:05x}", now, random_u64() & 0xfffff),
            ts: now,
            date: date_key(self.today(tz, now)),
            ml,
            offset_min: offset_minutes(tz, now),
        };
        self.data.entries.push(entry.clone());
        self.save_result().map(|_| entry)
    }

    pub fn undo_last(&mut self) -> Result<Option<Entry>, String> {
        let Some(idx) = self.data.entries.iter().enumerate().max_by_key(|(_, e)| e.ts).map(|(i, _)| i) else {
            return Ok(None);
        };
        let removed = self.data.entries.remove(idx);
        self.save_result().map(|_| Some(removed))
    }

    pub fn delete_entry(&mut self, id: &str) -> Result<bool, String> {
        let before = self.data.entries.len();
        self.data.entries.retain(|e| e.id != id);
        if self.data.entries.len() == before {
            return Ok(false);
        }
        self.save_result().map(|_| true)
    }

    pub fn update_settings<Tz: TimeZone>(&mut self, tz: &Tz, now: i64, mut next: Settings) -> Result<(), String> {
        next.pet_name = next.pet_name.trim().to_string();
        next.validate()?;
        // Machine-local facts are not editable through a settings save.
        next.onboarded = self.data.settings.onboarded;
        next.tray_verified = self.data.settings.tray_verified;
        if next.close_to_tray && !next.tray_verified {
            return Err("confirm the tray icon works before enabling close-to-tray".into());
        }
        // Freeze today's goal under the old value so the change starts tomorrow.
        self.roll_day(tz, now);
        self.data.settings = next;
        self.save_result()
    }

    /// First-run setup: unlike a normal settings change, the goal applies today.
    pub fn complete_onboarding<Tz: TimeZone>(&mut self, tz: &Tz, now: i64, mut next: Settings) -> Result<(), String> {
        next.pet_name = next.pet_name.trim().to_string();
        next.validate()?;
        next.onboarded = true;
        next.tray_verified = self.data.settings.tray_verified;
        next.close_to_tray = next.close_to_tray && next.tray_verified;
        let today = date_key(self.today(tz, now));
        self.data.day_goals.insert(today, next.goal_ml);
        self.data.settings = next;
        self.save_result()
    }

    pub fn confirm_tray(&mut self, works: bool) -> Result<(), String> {
        self.data.settings.tray_verified = works;
        if !works {
            self.data.settings.close_to_tray = false;
        }
        self.save_result()
    }

    fn freeze<Tz: TimeZone>(&mut self, tz: &Tz, now: i64, until: i64) {
        let today = date_key(self.today(tz, now));
        let rt = &mut self.data.runtime;
        if rt.freeze_date.as_deref() != Some(today.as_str()) {
            rt.freeze_date = Some(today);
            rt.freezes.clear();
        }
        rt.freezes.push((now, until));
    }

    pub fn snooze<Tz: TimeZone>(&mut self, tz: &Tz, now: i64, minutes: u32) -> Result<(), String> {
        if ![15, 30, 60].contains(&minutes) {
            return Err("snooze must be 15, 30 or 60 minutes".into());
        }
        let until = now + minutes as i64 * 60_000;
        let current = self.data.runtime.snooze_until.filter(|&s| s > now);
        let until = current.map_or(until, |c| c.max(until));
        self.freeze(tz, now, until);
        self.data.runtime.snooze_until = Some(until);
        self.save_result()
    }

    pub fn pause_today<Tz: TimeZone>(&mut self, tz: &Tz, now: i64) -> Result<(), String> {
        let today = date_key(self.today(tz, now));
        self.freeze(tz, now, i64::MAX);
        self.data.runtime.paused_date = Some(today);
        self.save_result()
    }

    pub fn resume(&mut self, now: i64) -> Result<(), String> {
        let rt = &mut self.data.runtime;
        rt.paused_date = None;
        rt.snooze_until = None;
        for f in rt.freezes.iter_mut() {
            f.1 = f.1.min(now);
        }
        self.save_result()
    }

    pub fn mark_boot_shown<Tz: TimeZone>(&mut self, tz: &Tz, now: i64) -> Result<(), String> {
        self.data.runtime.last_boot_date = Some(date_key(self.today(tz, now)));
        self.save_result()
    }

    pub fn stage_import(&mut self, json: &str, now: i64) -> Result<ImportPreview, String> {
        let incoming: Data = serde_json::from_str(json).map_err(|e| format!("not a hydration.sys export: {e}"))?;
        validate_data(&incoming, now)?;
        let mut dates: Vec<&str> = incoming.entries.iter().map(|e| e.date.as_str()).collect();
        dates.sort_unstable();
        dates.dedup();
        let preview = ImportPreview {
            entries: incoming.entries.len(),
            days: dates.len(),
            first_date: dates.first().map(|s| s.to_string()),
            last_date: dates.last().map(|s| s.to_string()),
            total_ml: incoming.entries.iter().map(|e| e.ml as u64).sum(),
            pet_name: incoming.settings.pet_name.clone(),
            current_entries: self.data.entries.len(),
        };
        self.pending_import = Some((incoming, preview.clone()));
        self.dirty = true;
        Ok(preview)
    }

    pub fn cancel_import(&mut self) {
        self.pending_import = None;
        self.dirty = true;
    }

    /// Replaces entries, goals and settings in one step. On any failure the
    /// previous data is restored untouched.
    pub fn confirm_import(&mut self, now: i64) -> Result<usize, String> {
        let Some((incoming, preview)) = self.pending_import.take() else {
            return Err("no import is waiting for confirmation".into());
        };
        self.store.snapshot_before("pre-import", now).map_err(|e| format!("could not back up current data: {e}"))?;
        let previous = self.data.clone();
        let mut next = incoming;
        next.settings.onboarded = true;
        next.settings.tray_verified = previous.settings.tray_verified;
        next.settings.close_to_tray = previous.settings.close_to_tray && previous.settings.tray_verified;
        next.runtime = Default::default();
        next.runtime.last_boot_date = previous.runtime.last_boot_date.clone();
        self.data = next;
        if let Err(e) = self.save_result() {
            self.data = previous;
            return Err(e);
        }
        Ok(preview.entries)
    }

    pub fn reset_all(&mut self, now: i64) -> Result<(), String> {
        self.store.snapshot_before("pre-reset", now).map_err(|e| format!("could not back up current data: {e}"))?;
        let previous = std::mem::take(&mut self.data);
        if let Err(e) = self.save_result() {
            self.data = previous;
            return Err(e);
        }
        Ok(())
    }

    pub fn dismiss_notice(&mut self) {
        self.notice = None;
    }

    pub fn export_json(&self, now: i64) -> String {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Export<'a> {
            version: u32,
            exported_at: i64,
            entries: &'a [Entry],
            day_goals: &'a BTreeMap<String, u32>,
            settings: &'a Settings,
        }
        serde_json::to_string_pretty(&Export {
            version: self.data.version,
            exported_at: now,
            entries: &self.data.entries,
            day_goals: &self.data.day_goals,
            settings: &self.data.settings,
        })
        .unwrap_or_default()
    }

    pub fn view<Tz: TimeZone>(&self, tz: &Tz, now: i64) -> CoreView {
        let today = date_key(self.today(tz, now));
        let (hunger, window) = self.hunger(tz, now);
        let rt = &self.data.runtime;
        CoreView {
            now,
            today: today.clone(),
            offset_min: offset_minutes(tz, now),
            window,
            entries: self.data.entries.clone(),
            day_goals: self.data.day_goals.clone(),
            settings: self.data.settings.clone(),
            today_goal: self.goal_for(&today),
            today_total: self.total_for(&today),
            hunger,
            reminders: ReminderView {
                decision: self.decision(tz, now),
                sent_today: if rt.sent_date.as_deref() == Some(today.as_str()) { rt.sent_count } else { 0 },
                last_reminder_ts: rt.last_reminder_ts,
                snooze_until: rt.snooze_until.filter(|&s| s > now),
                paused_today: rt.paused_date.as_deref() == Some(today.as_str()),
            },
            storage: StorageView {
                path: self.store.path().display().to_string(),
                last_save_ok: self.save_error.is_none(),
                last_error: self.save_error.clone(),
                notice: self.notice.clone(),
            },
            last_boot_date: rt.last_boot_date.clone(),
            last_notify: rt.last_notify.clone(),
            pending_import: self.pending_import.as_ref().map(|(_, p)| p.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::hunger::Pet;
    use crate::core::reminders::Block;
    use chrono_tz::Europe::Berlin;
    use std::path::PathBuf;

    const M: i64 = 60_000;
    const H: i64 = 60 * M;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        Berlin.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
    }

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn core(name: &str) -> (Core, Tmp) {
        let dir = std::env::temp_dir().join(format!("hydration-core-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let now = at(2026, 10, 27, 8, 0);
        (Core::open(Store::new(dir.clone()), now), Tmp(dir))
    }

    #[test]
    fn core_loop_log_save_reload() {
        let (mut c, t) = core("loop");
        let now = at(2026, 10, 27, 10, 0);
        c.roll_day(&Berlin, now);
        let e = c.log_drink(&Berlin, now, 250).unwrap();
        assert_eq!(e.date, "2026-10-27");
        assert_eq!(e.offset_min, 60);
        assert!(c.log_drink(&Berlin, now, 0).is_err());
        assert!(c.log_drink(&Berlin, now, 2001).is_err());
        let reopened = Core::open(Store::new(t.0.clone()), now);
        assert_eq!(reopened.data.entries, vec![e]);
        assert!(reopened.notice.is_none());
    }

    #[test]
    fn goal_change_applies_next_day() {
        let (mut c, _t) = core("goal");
        let now = at(2026, 10, 27, 10, 0);
        c.roll_day(&Berlin, now);
        let s = Settings { goal_ml: 3000, ..c.data.settings.clone() };
        c.update_settings(&Berlin, now, s).unwrap();
        assert_eq!(c.view(&Berlin, now).today_goal, 2000);
        let tomorrow = at(2026, 10, 28, 10, 0);
        c.roll_day(&Berlin, tomorrow);
        assert_eq!(c.view(&Berlin, tomorrow).today_goal, 3000);
        assert_eq!(c.data.day_goals["2026-10-27"], 2000);
    }

    #[test]
    fn onboarding_goal_applies_today() {
        let (mut c, _t) = core("onboard");
        let now = at(2026, 10, 27, 10, 0);
        c.roll_day(&Berlin, now);
        let s = Settings { goal_ml: 2500, ..Settings::default() };
        c.complete_onboarding(&Berlin, now, s).unwrap();
        assert_eq!(c.view(&Berlin, now).today_goal, 2500);
        assert!(c.data.settings.onboarded);
    }

    #[test]
    fn undo_and_delete_recalculate_totals() {
        let (mut c, _t) = core("undo");
        let now = at(2026, 10, 27, 10, 0);
        let a = c.log_drink(&Berlin, now, 250).unwrap();
        c.log_drink(&Berlin, now + M, 500).unwrap();
        assert_eq!(c.view(&Berlin, now + 2 * M).today_total, 750);
        c.undo_last().unwrap();
        assert_eq!(c.view(&Berlin, now + 2 * M).today_total, 250);
        assert!(c.delete_entry(&a.id).unwrap());
        assert!(!c.delete_entry(&a.id).unwrap());
        assert_eq!(c.view(&Berlin, now + 2 * M).today_total, 0);
        assert_eq!(c.undo_last().unwrap(), None);
    }

    #[test]
    fn local_day_rollover_resets_counters() {
        let (mut c, _t) = core("rollover");
        let late = at(2026, 10, 27, 20, 0);
        c.roll_day(&Berlin, late);
        c.record_reminder(&Berlin, late);
        c.pause_today(&Berlin, late).unwrap();
        assert!(c.view(&Berlin, late).reminders.paused_today);
        let next = at(2026, 10, 28, 9, 0);
        assert!(c.roll_day(&Berlin, next));
        let v = c.view(&Berlin, next);
        assert!(!v.reminders.paused_today);
        assert_eq!(v.reminders.sent_today, 0);
        assert_eq!(v.today, "2026-10-28");
    }

    #[test]
    fn drink_just_after_midnight_counts_for_new_day() {
        let (mut c, _t) = core("midnight");
        c.log_drink(&Berlin, at(2026, 10, 27, 23, 59), 250).unwrap();
        c.log_drink(&Berlin, at(2026, 10, 28, 0, 1), 300).unwrap();
        let v = c.view(&Berlin, at(2026, 10, 28, 0, 2));
        assert_eq!(v.today_total, 300);
    }

    #[test]
    fn dst_fall_back_day_keeps_entries_on_local_date() {
        // Berlin falls back on 2026-10-25 at 03:00 -> 02:00.
        let (mut c, _t) = core("dst");
        let e1 = c.log_drink(&Berlin, at(2026, 10, 25, 1, 30), 250).unwrap();
        let after = Berlin.with_ymd_and_hms(2026, 10, 25, 2, 30, 0).latest().unwrap().timestamp_millis();
        let e2 = c.log_drink(&Berlin, after, 250).unwrap();
        assert_eq!(e1.date, "2026-10-25");
        assert_eq!(e2.date, "2026-10-25");
        assert_eq!(e1.offset_min, 120);
        assert_eq!(e2.offset_min, 60);
    }

    #[test]
    fn pause_freezes_hunger_and_blocks_reminders() {
        let (mut c, _t) = core("pause");
        let start = at(2026, 10, 27, 9, 0);
        c.roll_day(&Berlin, start);
        c.pause_today(&Berlin, start + 30 * M).unwrap();
        let later = start + 6 * H;
        let v = c.view(&Berlin, later);
        assert_eq!(v.hunger.hungry_for_min, 30);
        assert_eq!(v.reminders.decision.block, Some(Block::PausedToday));
        c.resume(later).unwrap();
        let v = c.view(&Berlin, later + 100 * M);
        assert_eq!(v.hunger.hungry_for_min, 130);
        assert!(v.reminders.decision.fire);
    }

    #[test]
    fn snooze_extends_and_freezes() {
        let (mut c, _t) = core("snooze");
        let now = at(2026, 10, 27, 11, 0);
        c.roll_day(&Berlin, now);
        assert!(c.snooze(&Berlin, now, 20).is_err());
        c.snooze(&Berlin, now, 30).unwrap();
        c.snooze(&Berlin, now + 5 * M, 15).unwrap(); // shorter snooze never shortens
        assert_eq!(c.data.runtime.snooze_until, Some(now + 30 * M));
        let v = c.view(&Berlin, now + 10 * M);
        assert_eq!(v.reminders.decision.block, Some(Block::Snoozed));
    }

    #[test]
    fn reminders_stop_after_goal() {
        let (mut c, _t) = core("goalstop");
        let now = at(2026, 10, 27, 12, 0);
        c.roll_day(&Berlin, now);
        c.log_drink(&Berlin, now, 2000).unwrap();
        let v = c.view(&Berlin, now + 5 * H);
        assert_eq!(v.reminders.decision.block, Some(Block::GoalMet));
        assert_eq!(v.hunger.pet, Pet::Goal);
        // Extra water is recorded honestly but changes nothing else.
        c.log_drink(&Berlin, now + 5 * H, 1000).unwrap();
        let v = c.view(&Berlin, now + 5 * H + 10 * M);
        assert_eq!(v.today_total, 3000);
        assert_eq!(v.hunger.pet, Pet::Goal);
    }

    #[test]
    fn close_to_tray_requires_verified_tray() {
        let (mut c, _t) = core("tray");
        let now = at(2026, 10, 27, 12, 0);
        let s = Settings { close_to_tray: true, ..c.data.settings.clone() };
        assert!(c.update_settings(&Berlin, now, s.clone()).is_err());
        c.confirm_tray(true).unwrap();
        c.update_settings(&Berlin, now, s).unwrap();
        assert!(c.data.settings.close_to_tray);
        c.confirm_tray(false).unwrap();
        assert!(!c.data.settings.close_to_tray);
    }

    #[test]
    fn import_is_validated_staged_and_atomic() {
        let (mut c, t) = core("import");
        let now = at(2026, 10, 27, 12, 0);
        c.log_drink(&Berlin, now, 250).unwrap();
        assert!(c.stage_import("{\"version\":1,\"entries\":[{\"id\":\"x\",\"ts\":1,\"date\":\"1970-01-01\",\"ml\":250}]}", now).is_err());
        assert!(c.stage_import("nonsense", now).is_err());
        assert!(c.confirm_import(now).is_err());

        let mut other = Data::default();
        other.settings.pet_name = "Imported".into();
        for i in 0..3 {
            other.entries.push(Entry { id: format!("i{i}"), ts: now - i * 86_400_000, date: date_key(local_date(&Berlin, now - i * 86_400_000)), ml: 500, offset_min: 60 });
        }
        let json = serde_json::to_string(&other).unwrap();
        let p = c.stage_import(&json, now).unwrap();
        assert_eq!((p.entries, p.days, p.total_ml, p.current_entries), (3, 3, 1500, 1));
        // Nothing has changed until confirmed.
        assert_eq!(c.data.entries.len(), 1);
        c.confirm_import(now).unwrap();
        assert_eq!(c.data.entries.len(), 3);
        assert_eq!(c.data.settings.pet_name, "Imported");
        assert!(c.data.settings.onboarded);
        // The pre-import copy exists.
        assert!(std::fs::read_dir(&t.0).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("pre-import")));
    }

    #[test]
    fn export_roundtrips_through_import() {
        let (mut c, _t) = core("export");
        let now = at(2026, 10, 27, 12, 0);
        c.roll_day(&Berlin, now);
        c.log_drink(&Berlin, now, 333).unwrap();
        let json = c.export_json(now);
        let p = c.stage_import(&json, now).unwrap();
        assert_eq!(p.entries, 1);
    }

    #[test]
    fn reset_backs_up_first() {
        let (mut c, t) = core("reset");
        let now = at(2026, 10, 27, 12, 0);
        c.log_drink(&Berlin, now, 250).unwrap();
        c.reset_all(now).unwrap();
        assert!(c.data.entries.is_empty());
        assert!(!c.data.settings.onboarded);
        assert!(std::fs::read_dir(&t.0).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("pre-reset")));
    }

    #[test]
    fn save_failure_is_reported_not_hidden() {
        let dir = std::env::temp_dir().join(format!("hydration-core-ro-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // A *file* where the data directory should be makes every save fail.
        std::fs::write(&dir, b"not a dir").unwrap();
        let mut c = Core::open(Store::new(dir.clone()), at(2026, 10, 27, 8, 0));
        let r = c.log_drink(&Berlin, at(2026, 10, 27, 10, 0), 250);
        assert!(r.is_err());
        let v = c.view(&Berlin, at(2026, 10, 27, 10, 1));
        assert!(!v.storage.last_save_ok);
        assert!(v.storage.last_error.is_some());
        let _ = std::fs::remove_file(&dir);
    }
}
