//! Local-calendar helpers. Everything takes a `TimeZone` so tests can pin a
//! zone with DST; production passes `chrono::Local`.

use chrono::{Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};

pub const MINUTE_MS: i64 = 60_000;
pub const DAY_MIN: u32 = 1440;

pub fn local_date<Tz: TimeZone>(tz: &Tz, ts_ms: i64) -> NaiveDate {
    tz.timestamp_millis_opt(ts_ms)
        .earliest()
        .map(|t| t.naive_local().date())
        .unwrap_or_default()
}

pub fn date_key(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

pub fn offset_minutes<Tz: TimeZone>(tz: &Tz, ts_ms: i64) -> i32 {
    match tz.timestamp_millis_opt(ts_ms).earliest() {
        Some(t) => {
            let local = t.naive_local();
            let utc = t.naive_utc();
            ((local - utc).num_seconds() / 60) as i32
        }
        None => 0,
    }
}

/// Epoch ms of `minute` minutes after local midnight of `d`. A wall time that
/// does not exist (spring-forward gap) resolves to the first valid instant
/// after it; an ambiguous one (fall-back) to the earlier instant.
pub fn local_ms<Tz: TimeZone>(tz: &Tz, d: NaiveDate, minute: u32) -> i64 {
    let (day, minute) = if minute >= DAY_MIN { (d + Duration::days(1), minute - DAY_MIN) } else { (d, minute) };
    let naive = NaiveDateTime::new(day, NaiveTime::from_hms_opt(minute / 60, minute % 60, 0).unwrap());
    resolve(tz, naive)
}

fn resolve<Tz: TimeZone>(tz: &Tz, naive: NaiveDateTime) -> i64 {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(t) => t.timestamp_millis(),
        LocalResult::Ambiguous(a, _) => a.timestamp_millis(),
        LocalResult::None => {
            // Walk forward in 15-minute steps (gaps are at most a few hours).
            let mut probe = naive;
            for _ in 0..16 {
                probe += Duration::minutes(15);
                if let Some(t) = tz.from_local_datetime(&probe).earliest() {
                    return t.timestamp_millis();
                }
            }
            tz.from_utc_datetime(&naive).timestamp_millis()
        }
    }
}

/// [start, end) of the user's active hours on local date `d`, in epoch ms.
pub fn day_window<Tz: TimeZone>(tz: &Tz, d: NaiveDate, start_min: u32, end_min: u32) -> (i64, i64) {
    (local_ms(tz, d, start_min), local_ms(tz, d, end_min))
}

/// Quiet-hour intervals that intersect local date `d`. A range that wraps past
/// midnight (e.g. 22:00-07:00) yields the morning tail and the evening head.
pub fn quiet_intervals<Tz: TimeZone>(tz: &Tz, d: NaiveDate, start: u32, end: u32) -> Vec<(i64, i64)> {
    if start < end {
        vec![(local_ms(tz, d, start), local_ms(tz, d, end))]
    } else {
        vec![(local_ms(tz, d, 0), local_ms(tz, d, end)), (local_ms(tz, d, start), local_ms(tz, d, DAY_MIN))]
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::America::New_York;
    use chrono_tz::Europe::Berlin;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn local_date_uses_local_not_utc() {
        // 2026-10-27 02:30 UTC is still the 26th in New York.
        let ts = chrono::Utc.with_ymd_and_hms(2026, 10, 27, 2, 30, 0).unwrap().timestamp_millis();
        assert_eq!(date_key(local_date(&New_York, ts)), "2026-10-26");
        assert_eq!(date_key(local_date(&Berlin, ts)), "2026-10-27");
    }

    #[test]
    fn spring_forward_gap_resolves_forward() {
        // 2026-03-08 02:30 does not exist in New York; resolves to 03:00 EDT.
        let ms = local_ms(&New_York, d("2026-03-08"), 150);
        let t = New_York.timestamp_millis_opt(ms).unwrap();
        assert_eq!(t.format("%H:%M").to_string(), "03:00");
    }

    #[test]
    fn dst_days_have_23_and_25_hours() {
        let spring = local_ms(&New_York, d("2026-03-08"), DAY_MIN) - local_ms(&New_York, d("2026-03-08"), 0);
        assert_eq!(spring, 23 * 3_600_000);
        let fall = local_ms(&New_York, d("2026-11-01"), DAY_MIN) - local_ms(&New_York, d("2026-11-01"), 0);
        assert_eq!(fall, 25 * 3_600_000);
        // Active window 09:00-21:00 is 12 real hours even on DST days.
        let (s, e) = day_window(&New_York, d("2026-11-01"), 540, 1260);
        assert_eq!(e - s, 12 * 3_600_000);
    }

    #[test]
    fn offsets_follow_dst() {
        let summer = chrono::Utc.with_ymd_and_hms(2026, 7, 1, 12, 0, 0).unwrap().timestamp_millis();
        let winter = chrono::Utc.with_ymd_and_hms(2026, 12, 1, 12, 0, 0).unwrap().timestamp_millis();
        assert_eq!(offset_minutes(&New_York, summer), -240);
        assert_eq!(offset_minutes(&New_York, winter), -300);
    }

    #[test]
    fn quiet_wraps_midnight() {
        let q = quiet_intervals(&Berlin, d("2026-10-27"), 22 * 60, 7 * 60);
        assert_eq!(q.len(), 2);
        assert_eq!(q[0].1 - q[0].0, 7 * 3_600_000);
    }

}
