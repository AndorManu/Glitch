//! The daily briefing: on the first chat of the day Glitch says the time,
//! the weather (Open-Meteo, free and without an API key, for the place the
//! user picked), today's reminders and open to-dos from his notes file.
//! Email and calendar have slots ([`Briefing::email`], [`Briefing::calendar`])
//! for when those sources exist.
//!
//! No model call: a template in Glitch's voice is instant and can't make
//! things up. The HTTP calls happen in the Tauri shell (it has TLS); the
//! URLs and the parsing live here so they are tested.

use chrono::{NaiveDate, NaiveDateTime, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::settings::Location;

pub const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
pub const GEOCODE_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";
const MAX_TODOS: usize = 3;
const MAX_REMINDERS: usize = 4;

pub fn forecast_url(loc: &Location) -> String {
    format!(
        "{FORECAST_URL}?latitude={:.4}&longitude={:.4}&current=temperature_2m,weather_code\
         &daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1",
        loc.latitude, loc.longitude
    )
}

pub fn geocode_url(name: &str) -> String {
    let q: String = url::form_urlencoded::byte_serialize(name.trim().as_bytes()).collect();
    format!("{GEOCODE_URL}?name={q}&count=5&language=en&format=json")
}

/// Places matching a search, "Berlin, Germany" style.
pub fn parse_geocode(v: &Value) -> Vec<Location> {
    let Some(results) = v.get("results").and_then(Value::as_array) else { return vec![] };
    results
        .iter()
        .filter_map(|r| {
            let name = r.get("name")?.as_str()?;
            let latitude = r.get("latitude")?.as_f64()?;
            let longitude = r.get("longitude")?.as_f64()?;
            let parts: Vec<&str> =
                [Some(name), r.get("admin1").and_then(Value::as_str), r.get("country").and_then(Value::as_str)]
                    .into_iter()
                    .flatten()
                    .collect();
            let mut label: Vec<&str> = Vec::new();
            for p in parts {
                if !label.contains(&p) {
                    label.push(p);
                }
            }
            Some(Location { name: super::clean(&label.join(", "), 80), latitude, longitude })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Weather {
    pub now_c: f64,
    pub max_c: Option<f64>,
    pub min_c: Option<f64>,
    pub rain_chance: Option<f64>,
    pub code: u32,
}

pub fn parse_forecast(v: &Value) -> Option<Weather> {
    let cur = v.get("current")?;
    let daily = v.get("daily");
    let first = |k: &str| daily.and_then(|d| d.get(k)).and_then(|a| a.get(0)).and_then(Value::as_f64);
    Some(Weather {
        now_c: cur.get("temperature_2m")?.as_f64()?,
        max_c: first("temperature_2m_max"),
        min_c: first("temperature_2m_min"),
        rain_chance: first("precipitation_probability_max"),
        code: cur.get("weather_code").and_then(Value::as_u64).unwrap_or(0) as u32,
    })
}

/// WMO weather codes in words.
pub fn sky(code: u32) -> &'static str {
    match code {
        0 => "clear skies",
        1 | 2 => "a few clouds",
        3 => "grey and cloudy",
        45 | 48 => "foggy",
        51..=57 => "drizzly",
        61..=67 | 80..=82 => "rainy",
        71..=77 | 85 | 86 => "snowy",
        95..=99 => "stormy",
        _ => "weather of some kind",
    }
}

pub fn weather_line(w: &Weather, place: &str) -> String {
    let mut s = format!("{place}: {:.0}°C and {}", w.now_c, sky(w.code));
    if let (Some(lo), Some(hi)) = (w.min_c, w.max_c) {
        s.push_str(&format!(", {lo:.0} to {hi:.0}°C today"));
    }
    s.push('.');
    if w.rain_chance.is_some_and(|r| r >= 50.0) {
        s.push_str(" Take an umbrella, I'm not drying you off.");
    }
    s
}

/// Open to-dos (`- [ ] ...`) from the notes file, oldest first.
pub fn todos_from_notes(notes: &str) -> Vec<String> {
    notes
        .lines()
        .filter_map(|l| {
            let l = l.trim_start();
            l.strip_prefix("- [ ]").or_else(|| l.strip_prefix("* [ ]")).map(|t| super::clean(t, 80))
        })
        .filter(|t| !t.is_empty())
        .take(MAX_TODOS)
        .collect()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Briefing {
    pub greeting: String,
    pub weather: Option<String>,
    /// "17:00 call mum"
    pub reminders: Vec<String>,
    pub todos: Vec<String>,
    /// Slots for later sources (unread mail, today's meetings).
    pub email: Option<String>,
    pub calendar: Option<String>,
}

impl Briefing {
    /// The whole briefing as the bubble shows it.
    pub fn text(&self) -> String {
        let mut parts = vec![self.greeting.clone()];
        parts.extend(self.weather.clone());
        parts.extend(self.calendar.clone());
        parts.extend(self.email.clone());
        match self.reminders.len() {
            0 => {}
            _ => parts.push(format!("Today I'll remind you: {}.", self.reminders.join("; "))),
        }
        if !self.todos.is_empty() {
            parts.push(format!("Open to-dos: {}.", self.todos.join("; ")));
        }
        if self.reminders.is_empty() && self.todos.is_empty() {
            parts.push("Nothing on my list for you today. Suspicious.".into());
        }
        parts.join(" ")
    }
}

fn greeting(now: NaiveDateTime) -> String {
    let when = match now.hour() {
        5..=11 => "Morning",
        12..=17 => "Afternoon",
        18..=22 => "Evening",
        _ => "Hey night owl",
    };
    format!("{when}! It's {} on {}.", now.format("%H:%M"), now.format("%A %-d %B"))
}

/// `reminders`: (local time, text) of today's reminders.
pub fn compose(
    now: NaiveDateTime,
    weather: Option<String>,
    reminders: &[(NaiveDateTime, String)],
    todos: Vec<String>,
) -> Briefing {
    Briefing {
        greeting: greeting(now),
        weather,
        reminders: reminders.iter().take(MAX_REMINDERS).map(|(t, s)| format!("{} {s}", t.format("%H:%M"))).collect(),
        todos,
        email: None,
        calendar: None,
    }
}

/// The briefing is given once per day: has it been given `today`?
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BriefingState {
    pub last: Option<NaiveDate>,
}

impl BriefingState {
    pub fn due(&self, today: NaiveDate) -> bool {
        self.last != Some(today)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn urls() {
        let loc = Location { name: "Berlin".into(), latitude: 52.52437, longitude: 13.41053 };
        let u = forecast_url(&loc);
        assert!(u.starts_with("https://api.open-meteo.com/v1/forecast?latitude=52.5244&longitude=13.4105"));
        assert!(!u.contains("apikey"));
        assert_eq!(geocode_url("Den Haag"), format!("{GEOCODE_URL}?name=Den+Haag&count=5&language=en&format=json"));
    }

    #[test]
    fn geocode_and_forecast_parsing() {
        let g = json!({"results": [
            {"name": "Berlin", "latitude": 52.5, "longitude": 13.4, "admin1": "Land Berlin", "country": "Germany"},
            {"name": "Berlin", "latitude": 44.4, "longitude": -71.1, "admin1": "New Hampshire", "country": "United States"},
            {"name": "broken"}
        ]});
        let places = parse_geocode(&g);
        assert_eq!(places.len(), 2);
        assert_eq!(places[0].name, "Berlin, Land Berlin, Germany");
        assert!(parse_geocode(&json!({})).is_empty());
        let f = json!({
            "current": {"temperature_2m": 11.6, "weather_code": 61},
            "daily": {"temperature_2m_max": [14.2], "temperature_2m_min": [7.9], "precipitation_probability_max": [80]}
        });
        let w = parse_forecast(&f).unwrap();
        assert_eq!(w.code, 61);
        assert_eq!(
            weather_line(&w, "Berlin"),
            "Berlin: 12°C and rainy, 8 to 14°C today. Take an umbrella, I'm not drying you off."
        );
        assert_eq!(parse_forecast(&json!({"error": true})), None);
    }

    #[test]
    fn todos() {
        let notes = "# notes\n- [ ] buy milk\n- [x] done thing\n  - [ ] fix bike\n* [ ] call Bob\n- [ ] fourth\n";
        assert_eq!(todos_from_notes(notes), ["buy milk", "fix bike", "call Bob"]);
    }

    #[test]
    fn composed_text() {
        let now = NaiveDate::from_ymd_opt(2026, 10, 8).unwrap().and_hms_opt(8, 5, 0).unwrap();
        let five = now.date().and_hms_opt(17, 0, 0).unwrap();
        let b =
            compose(now, Some("Berlin: 12°C and rainy.".into()), &[(five, "call mum".into())], vec!["buy milk".into()]);
        assert_eq!(
            b.text(),
            "Morning! It's 08:05 on Thursday 8 October. Berlin: 12°C and rainy. Today I'll remind you: 17:00 call mum. Open to-dos: buy milk."
        );
        let empty = compose(now, None, &[], vec![]);
        assert!(empty.text().ends_with("Suspicious."));
        assert!(!b.text().contains('\u{2014}'));
        let mut s = BriefingState::default();
        assert!(s.due(now.date()));
        s.last = Some(now.date());
        assert!(!s.due(now.date()));
        assert!(s.due(now.date().succ_opt().unwrap()));
    }
}
