//! Byte's lines for notifications and the tray, read from the same
//! `copy.json` the UI uses so the two can never drift apart.

use std::sync::OnceLock;

use serde_json::Value;

use super::model::{Settings, Unit};

static COPY: OnceLock<Value> = OnceLock::new();

fn copy() -> &'static Value {
    COPY.get_or_init(|| serde_json::from_str(include_str!("../../../src/core/copy.json")).expect("copy.json is valid"))
}

pub fn voice(settings: &Settings) -> &'static str {
    if settings.no_jokes {
        "plain"
    } else if settings.chill {
        "chill"
    } else {
        "byte"
    }
}

pub fn format_ml(ml: u32, unit: Unit) -> String {
    match unit {
        Unit::Ml if ml >= 1000 => format!("{},{:03} mL", ml / 1000, ml % 1000),
        Unit::Ml => format!("{ml} mL"),
        Unit::Oz => {
            let oz = ml as f64 / 29.5735;
            if oz >= 10.0 { format!("{oz:.0} oz") } else { format!("{oz:.1} oz") }
        }
    }
}

/// Picks line `seed % n` of a situation and fills in the placeholders.
pub fn line(settings: &Settings, kind: &str, seed: u64, ml: Option<u32>) -> String {
    let lines = copy()[voice(settings)][kind].as_array().or_else(|| copy()["byte"][kind].as_array());
    let Some(lines) = lines.filter(|l| !l.is_empty()) else {
        return String::new();
    };
    let raw = lines[(seed % lines.len() as u64) as usize].as_str().unwrap_or_default();
    raw.replace("{name}", settings.pet_name.trim())
        .replace("{ml}", &ml.map(|m| format_ml(m, settings.unit)).unwrap_or_default())
        .replace("{goal}", &format_ml(settings.goal_ml, settings.unit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_situation_has_eight_byte_lines() {
        for kind in ["log", "reminder", "hungry", "veryHungry", "recovered", "goal", "morning", "quiet"] {
            let n = copy()["byte"][kind].as_array().map_or(0, |a| a.len());
            assert!(n >= 8, "{kind} has {n} lines");
        }
    }

    #[test]
    fn placeholders_and_voices() {
        let mut s = Settings { pet_name: "Pixel".into(), ..Settings::default() };
        let l = line(&s, "log", 0, Some(250));
        assert_eq!(l, "+250 mL accepted. Pixel.exe is thriving.");
        s.no_jokes = true;
        assert_eq!(line(&s, "log", 3, Some(250)), "Logged 250 mL.");
        assert_eq!(format_ml(2000, Unit::Ml), "2,000 mL");
        assert_eq!(format_ml(10_050, Unit::Ml), "10,050 mL");
        s.unit = Unit::Oz;
        assert_eq!(line(&s, "log", 0, Some(237)), "Logged 8.0 oz.");
    }
}
