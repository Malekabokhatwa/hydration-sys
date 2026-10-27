//! Hunger is never stored. It is derived from how many *active* minutes have
//! passed since the last drink today, minus time spent paused or snoozed,
//! and softened when today's intake is on pace for the goal.

use serde::Serialize;

use super::time::MINUTE_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Fed,
    Peckish,
    Hungry,
    VeryHungry,
}

/// What the pet shows. `Stage` drives hunger; `Pet` adds short-lived moods.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Pet {
    Idle,
    Happy,
    Thirsty,
    Hungry,
    VeryHungry,
    Recovering,
    Goal,
    Sleeping,
}

#[derive(Debug, Clone, Copy)]
pub struct Thresholds {
    pub peckish_min: u32,
    pub hungry_min: u32,
    pub very_hungry_min: u32,
}

pub struct HungerInput<'a> {
    pub now: i64,
    /// Timestamps of today's drinks (local day), any order.
    pub today_logs: &'a [i64],
    pub window: (i64, i64),
    /// Intervals during which hunger is frozen (snooze, pause-for-today).
    pub pauses: &'a [(i64, i64)],
    pub total_ml: u32,
    pub goal_ml: u32,
    pub thresholds: Thresholds,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunger {
    pub stage: Stage,
    pub pet: Pet,
    /// Active, unpaused minutes since the last drink (or since the start of
    /// today's active hours when nothing has been logged yet today).
    pub hungry_for_min: i64,
    pub goal_met: bool,
    pub in_active_hours: bool,
}

pub const HAPPY_MS: i64 = 3 * MINUTE_MS;
pub const RECOVERING_MS: i64 = 10 * MINUTE_MS;

/// Milliseconds of [from, to) that fall inside `window` and outside `pauses`.
pub fn active_ms(from: i64, to: i64, window: (i64, i64), pauses: &[(i64, i64)]) -> i64 {
    let a = from.max(window.0);
    let b = to.min(window.1);
    if b <= a {
        return 0;
    }
    let mut clipped: Vec<(i64, i64)> = pauses
        .iter()
        .map(|&(s, e)| (s.max(a), e.min(b)))
        .filter(|(s, e)| e > s)
        .collect();
    clipped.sort_unstable();
    let mut paused = 0;
    let mut cur: Option<(i64, i64)> = None;
    for (s, e) in clipped {
        match cur {
            Some((cs, ce)) if s <= ce => cur = Some((cs, ce.max(e))),
            Some((cs, ce)) => {
                paused += ce - cs;
                cur = Some((s, e));
            }
            None => cur = Some((s, e)),
        }
    }
    if let Some((cs, ce)) = cur {
        paused += ce - cs;
    }
    (b - a) - paused
}

pub fn stage_for(minutes: i64, t: Thresholds) -> Stage {
    if minutes >= t.very_hungry_min as i64 {
        Stage::VeryHungry
    } else if minutes >= t.hungry_min as i64 {
        Stage::Hungry
    } else if minutes >= t.peckish_min as i64 {
        Stage::Peckish
    } else {
        Stage::Fed
    }
}

pub fn compute(input: &HungerInput) -> Hunger {
    let HungerInput { now, window, pauses, total_ml, goal_ml, thresholds, .. } = *input;
    let mut logs: Vec<i64> = input.today_logs.iter().copied().filter(|&t| t <= now).collect();
    logs.sort_unstable();

    let goal_met = goal_ml > 0 && total_ml >= goal_ml;
    let in_active = now >= window.0 && now < window.1;
    let last = logs.last().copied();
    let anchor = last.unwrap_or(window.0);
    let minutes = active_ms(anchor, now, window, pauses) / MINUTE_MS;

    let mut stage = if goal_met { Stage::Fed } else { stage_for(minutes, thresholds) };
    // On pace for the goal (intake >= expected share of the active window so
    // far): never worse than peckish.
    if !goal_met && stage > Stage::Peckish && window.1 > window.0 && now > window.0 {
        let elapsed = (now.min(window.1) - window.0) as f64 / (window.1 - window.0) as f64;
        if total_ml as f64 >= goal_ml as f64 * elapsed {
            stage = Stage::Peckish;
        }
    }

    let since_last = last.map(|t| now - t);
    let recovering = match (last, since_last) {
        (Some(t), Some(ago)) if ago < RECOVERING_MS => {
            // How hungry was the pet just before this drink?
            let prev = logs.iter().rev().nth(1).copied().unwrap_or(window.0);
            active_ms(prev, t, window, pauses) / MINUTE_MS >= thresholds.hungry_min as i64
        }
        _ => false,
    };

    let pet = if goal_met {
        if since_last.is_some_and(|a| a < HAPPY_MS) { Pet::Happy } else { Pet::Goal }
    } else if recovering {
        Pet::Recovering
    } else if since_last.is_some_and(|a| a < HAPPY_MS) {
        Pet::Happy
    } else if !in_active {
        Pet::Sleeping
    } else {
        match stage {
            Stage::Fed => Pet::Idle,
            Stage::Peckish => Pet::Thirsty,
            Stage::Hungry => Pet::Hungry,
            Stage::VeryHungry => Pet::VeryHungry,
        }
    };

    Hunger { stage, pet, hungry_for_min: minutes, goal_met, in_active_hours: in_active }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 3_600_000;
    const M: i64 = MINUTE_MS;
    // Fake clock: day starts at T0 (09:00), active until T0 + 12h.
    const T0: i64 = 1_000_000_000_000;
    const WIN: (i64, i64) = (T0, T0 + 12 * H);
    const TH: Thresholds = Thresholds { peckish_min: 90, hungry_min: 150, very_hungry_min: 240 };

    fn run(now: i64, logs: &[i64], pauses: &[(i64, i64)], total: u32) -> Hunger {
        compute(&HungerInput { now, today_logs: logs, window: WIN, pauses, total_ml: total, goal_ml: 2000, thresholds: TH })
    }

    #[test]
    fn stages_progress_with_time() {
        assert_eq!(run(T0 + 30 * M, &[], &[], 0).stage, Stage::Fed);
        assert_eq!(run(T0 + 95 * M, &[], &[], 0).stage, Stage::Peckish);
        assert_eq!(run(T0 + 155 * M, &[], &[], 0).stage, Stage::Hungry);
        assert_eq!(run(T0 + 245 * M, &[], &[], 0).stage, Stage::VeryHungry);
        assert_eq!(run(T0 + 245 * M, &[], &[], 0).pet, Pet::VeryHungry);
    }

    #[test]
    fn logging_feeds_immediately_and_caps_at_fed() {
        let now = T0 + 5 * H;
        let h = run(now, &[now - M], &[], 500);
        assert_eq!(h.stage, Stage::Fed);
        assert_eq!(h.pet, Pet::Recovering); // was very hungry before this drink
        // Several big drinks in a row are still just "fed", never more.
        let h2 = run(now, &[now - 3 * M, now - 2 * M, now - M], &[], 1500);
        assert_eq!(h2.stage, Stage::Fed);
        assert_eq!(h2.hungry_for_min, 1);
    }

    #[test]
    fn happy_right_after_a_normal_drink() {
        let h = run(T0 + 61 * M, &[T0 + 30 * M, T0 + 60 * M], &[], 500);
        assert_eq!(h.pet, Pet::Happy);
        let later = run(T0 + 70 * M, &[T0 + 30 * M, T0 + 60 * M], &[], 500);
        assert_eq!(later.pet, Pet::Idle);
    }

    #[test]
    fn no_progress_outside_active_hours() {
        // Before the window starts: zero minutes, pet asleep.
        let h = run(T0 - 2 * H, &[], &[], 0);
        assert_eq!(h.hungry_for_min, 0);
        assert_eq!(h.pet, Pet::Sleeping);
        // After the window ends hunger stops growing.
        let end = run(WIN.1 + 3 * H, &[WIN.1 - 100 * M], &[], 0);
        assert_eq!(end.hungry_for_min, 100);
        assert_eq!(end.pet, Pet::Sleeping);
    }

    #[test]
    fn pauses_freeze_hunger() {
        let pauses = [(T0 + 60 * M, T0 + 180 * M)];
        let h = run(T0 + 200 * M, &[], &pauses, 0);
        assert_eq!(h.hungry_for_min, 80);
        assert_eq!(h.stage, Stage::Fed);
        // Overlapping pauses are not double counted.
        let overlap = [(T0 + 60 * M, T0 + 120 * M), (T0 + 100 * M, T0 + 180 * M)];
        assert_eq!(run(T0 + 200 * M, &[], &overlap, 0).hungry_for_min, 80);
    }

    #[test]
    fn on_pace_softens_to_peckish() {
        // 6h in (half the window), 1000 mL logged long ago: on pace.
        let h = run(T0 + 6 * H, &[T0 + 10 * M], &[], 1000);
        assert_eq!(h.stage, Stage::Peckish);
        // Behind pace stays hungry.
        let h = run(T0 + 6 * H, &[T0 + 10 * M], &[], 200);
        assert_eq!(h.stage, Stage::VeryHungry);
    }

    #[test]
    fn goal_met_is_calm() {
        let h = run(T0 + 10 * H, &[T0 + 2 * H], &[], 2100);
        assert_eq!(h.stage, Stage::Fed);
        assert_eq!(h.pet, Pet::Goal);
        assert!(h.goal_met);
    }

    #[test]
    fn active_ms_clips() {
        assert_eq!(active_ms(T0 - H, T0 + H, WIN, &[]), H);
        assert_eq!(active_ms(T0 + H, T0, WIN, &[]), 0);
    }
}
