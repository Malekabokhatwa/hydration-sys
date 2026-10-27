//! Pure reminder decision. The scheduler thread calls `evaluate` on every
//! wake-up; because a fired reminder immediately becomes `last_reminder`, a
//! single evaluation can fire at most one reminder, and the minimum gap blocks
//! the next one. That is what prevents a catch-up burst after sleep/resume.

use serde::Serialize;

use super::time::MINUTE_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Block {
    Disabled,
    PausedToday,
    GoalMet,
    DailyMax,
    /// No reminder fits in what is left of today's active hours.
    DoneForToday,
    BeforeActive,
    Snoozed,
    Quiet,
    NotDue,
}

pub struct ReminderInput<'a> {
    pub now: i64,
    pub enabled: bool,
    pub window: (i64, i64),
    pub quiet: &'a [(i64, i64)],
    pub last_log: Option<i64>,
    pub last_reminder: Option<i64>,
    pub sent_today: u32,
    pub daily_max: u32,
    pub interval_min: u32,
    pub min_gap_min: u32,
    pub snooze_until: Option<i64>,
    pub paused_today: bool,
    pub goal_met: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub fire: bool,
    /// When the next reminder becomes due today, if one can still happen.
    pub due: Option<i64>,
    /// Why nothing fires right now.
    pub block: Option<Block>,
}

fn in_any(t: i64, ranges: &[(i64, i64)]) -> Option<(i64, i64)> {
    ranges.iter().copied().find(|&(s, e)| t >= s && t < e)
}

pub fn evaluate(i: &ReminderInput) -> Decision {
    let none = |b| Decision { fire: false, due: None, block: Some(b) };
    if !i.enabled {
        return none(Block::Disabled);
    }
    if i.paused_today {
        return none(Block::PausedToday);
    }
    if i.goal_met {
        return none(Block::GoalMet);
    }
    if i.sent_today >= i.daily_max {
        return none(Block::DailyMax);
    }
    let (ws, we) = i.window;
    let interval = i.interval_min as i64 * MINUTE_MS;

    // A clock stepped backwards can leave a "future" reminder or snooze
    // behind; ignore those instead of going silent until time catches up.
    let last_reminder = i.last_reminder.filter(|&t| t <= i.now);
    let snooze_until = i.snooze_until.map(|s| s.min(i.now + 60 * MINUTE_MS));

    // Timestamps from before today's window do not count as anchors: each day
    // starts fresh at the beginning of active hours.
    let anchor = [i.last_log, last_reminder].iter().flatten().copied().filter(|&t| t >= ws).max().unwrap_or(ws);
    let mut due = anchor + interval;
    if let Some(lr) = last_reminder {
        due = due.max(lr + i.min_gap_min as i64 * MINUTE_MS);
    }
    if let Some(s) = snooze_until {
        due = due.max(s);
    }
    // Push past quiet hours (they may chain).
    for _ in 0..4 {
        match in_any(due, i.quiet) {
            Some((_, e)) => due = e,
            None => break,
        }
    }
    if due >= we {
        return none(Block::DoneForToday);
    }

    let block = if i.now < ws {
        Some(Block::BeforeActive)
    } else if snooze_until.is_some_and(|s| i.now < s) {
        Some(Block::Snoozed)
    } else if in_any(i.now, i.quiet).is_some() {
        Some(Block::Quiet)
    } else if i.now < due {
        Some(Block::NotDue)
    } else if i.now >= we {
        Some(Block::DoneForToday)
    } else {
        None
    };
    Decision { fire: block.is_none(), due: Some(due), block }
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: i64 = MINUTE_MS;
    const H: i64 = 60 * M;
    const T0: i64 = 1_000_000_000_000;
    const WIN: (i64, i64) = (T0, T0 + 12 * H);

    fn base(now: i64) -> ReminderInput<'static> {
        ReminderInput {
            now,
            enabled: true,
            window: WIN,
            quiet: &[],
            last_log: None,
            last_reminder: None,
            sent_today: 0,
            daily_max: 8,
            interval_min: 75,
            min_gap_min: 45,
            snooze_until: None,
            paused_today: false,
            goal_met: false,
        }
    }

    #[test]
    fn first_reminder_after_interval_from_day_start() {
        assert!(!evaluate(&base(T0 + 74 * M)).fire);
        let d = evaluate(&base(T0 + 75 * M));
        assert!(d.fire);
        assert_eq!(d.due, Some(T0 + 75 * M));
    }

    #[test]
    fn logging_pushes_reminder() {
        let mut i = base(T0 + 100 * M);
        i.last_log = Some(T0 + 60 * M);
        let d = evaluate(&i);
        assert!(!d.fire);
        assert_eq!(d.due, Some(T0 + 135 * M));
    }

    #[test]
    fn yesterdays_log_is_not_an_anchor() {
        let mut i = base(T0 + 80 * M);
        i.last_log = Some(T0 - 13 * H);
        assert!(evaluate(&i).fire);
    }

    #[test]
    fn min_gap_and_interval_after_a_reminder() {
        let mut i = base(T0 + 3 * H);
        i.last_reminder = Some(T0 + 2 * H + 30 * M);
        i.sent_today = 1;
        let d = evaluate(&i);
        assert!(!d.fire);
        assert_eq!(d.due, Some(T0 + 2 * H + 30 * M + 75 * M));
        // A tiny interval cannot beat the minimum gap.
        i.interval_min = 15;
        i.min_gap_min = 45;
        assert_eq!(evaluate(&i).due, Some(T0 + 2 * H + 30 * M + 45 * M));
    }

    #[test]
    fn daily_max_goal_pause_disabled() {
        let mut i = base(T0 + 5 * H);
        i.sent_today = 8;
        assert_eq!(evaluate(&i).block, Some(Block::DailyMax));
        let mut i = base(T0 + 5 * H);
        i.goal_met = true;
        assert_eq!(evaluate(&i).block, Some(Block::GoalMet));
        let mut i = base(T0 + 5 * H);
        i.paused_today = true;
        assert_eq!(evaluate(&i).block, Some(Block::PausedToday));
        let mut i = base(T0 + 5 * H);
        i.enabled = false;
        assert_eq!(evaluate(&i).block, Some(Block::Disabled));
    }

    #[test]
    fn snooze_delays() {
        let mut i = base(T0 + 2 * H);
        i.snooze_until = Some(T0 + 2 * H + 30 * M);
        let d = evaluate(&i);
        assert_eq!(d.block, Some(Block::Snoozed));
        assert_eq!(d.due, Some(T0 + 2 * H + 30 * M));
        i.now = T0 + 2 * H + 30 * M;
        assert!(evaluate(&i).fire);
    }

    #[test]
    fn quiet_hours_push_due_to_their_end() {
        let quiet = [(T0 + 60 * M, T0 + 120 * M)];
        let mut i = base(T0 + 80 * M);
        i.quiet = &quiet;
        let d = evaluate(&i);
        assert!(!d.fire);
        assert_eq!(d.due, Some(T0 + 120 * M));
        i.now = T0 + 120 * M;
        assert!(evaluate(&i).fire);
    }

    #[test]
    fn outside_active_hours() {
        let d = evaluate(&base(T0 - H));
        assert_eq!(d.block, Some(Block::BeforeActive));
        let mut i = base(T0 + 12 * H + M);
        i.last_reminder = Some(T0 + 11 * H);
        i.sent_today = 3;
        assert_eq!(evaluate(&i).block, Some(Block::DoneForToday));
        // A reminder that would land after the window is dropped, not queued.
        let mut i = base(T0 + 11 * H);
        i.last_log = Some(T0 + 11 * H);
        assert_eq!(evaluate(&i).block, Some(Block::DoneForToday));
    }

    #[test]
    fn clock_stepped_back_does_not_silence_reminders() {
        let mut i = base(T0 + 3 * H);
        i.last_reminder = Some(T0 + 9 * H); // recorded before the clock went back
        i.snooze_until = Some(T0 + 10 * H);
        i.sent_today = 1;
        let d = evaluate(&i);
        assert!(d.due.unwrap() <= T0 + 4 * H, "due {:?}", d.due);
    }

    #[test]
    fn resume_after_long_sleep_fires_exactly_once() {
        // Machine slept from 10:00 until 16:00 with reminders due the whole time.
        let mut i = base(T0 + 7 * H);
        i.last_log = Some(T0 + H);
        let first = evaluate(&i);
        assert!(first.fire);
        // The scheduler records the reminder, then evaluates again right away.
        i.last_reminder = Some(i.now);
        i.sent_today = 1;
        let again = evaluate(&i);
        assert!(!again.fire);
        assert_eq!(again.due, Some(i.now + 75 * M));
        // Even many evaluations in the same minute stay silent.
        for s in 1..60 {
            i.now += 1000;
            assert!(!evaluate(&i).fire, "fired again after {s}s");
        }
    }
}
