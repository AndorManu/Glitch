//! "at 5", "tomorrow 9am", "in 20 minutes", "friday at noon": when a
//! reminder is due. Parsed here in Rust: small models are bad at clock
//! arithmetic, so the model passes the user's words and Rust does the maths.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Weekday};

/// When nothing but a day is given ("tomorrow").
const DEFAULT_HOUR: u32 = 9;

fn unit_seconds(unit: &str) -> Option<i64> {
    Some(match unit {
        "s" | "sec" | "secs" | "second" | "seconds" => 1,
        "m" | "min" | "mins" | "minute" | "minutes" => 60,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600,
        "d" | "day" | "days" => 86_400,
        "w" | "week" | "weeks" => 7 * 86_400,
        _ => return None,
    })
}

/// "in 20 minutes", "in an hour", "in half an hour", "20 min".
fn relative(s: &str) -> Option<Duration> {
    let s = s.strip_prefix("in ").unwrap_or(s).trim();
    if s == "half an hour" {
        return Some(Duration::minutes(30));
    }
    let words: Vec<&str> = s.split_whitespace().collect();
    let (num, unit) = match words.as_slice() {
        [n, u] => ((*n).to_string(), (*u).to_string()),
        [one] => {
            // "20min", "2h"
            let split = one.find(|c: char| !c.is_ascii_digit() && c != '.')?;
            (one[..split].to_string(), one[split..].to_string())
        }
        _ => return None,
    };
    let n: f64 = match num.as_str() {
        "a" | "an" | "one" => 1.0,
        "two" => 2.0,
        "few" => 3.0,
        n => n.parse().ok()?,
    };
    let secs = (n * unit_seconds(&unit)? as f64).round() as i64;
    (secs > 0).then(|| Duration::seconds(secs))
}

/// A clock time: (hour, minute, explicit am/pm or 24 h?).
fn clock(s: &str) -> Option<(u32, u32, bool)> {
    let s = s.trim();
    match s {
        "noon" | "midday" => return Some((12, 0, true)),
        "midnight" => return Some((0, 0, true)),
        "morning" => return Some((9, 0, true)),
        "afternoon" => return Some((14, 0, true)),
        "evening" => return Some((18, 0, true)),
        "night" | "tonight" => return Some((20, 0, true)),
        _ => {}
    }
    let (num, suffix) = if let Some(n) = s.strip_suffix("am").or_else(|| s.strip_suffix("a.m.")) {
        (n.trim(), Some(false))
    } else if let Some(n) = s.strip_suffix("pm").or_else(|| s.strip_suffix("p.m.")) {
        (n.trim(), Some(true))
    } else {
        (s, None)
    };
    let (h, m) = match num.split_once([':', '.', 'h']) {
        Some((h, m)) => (h.parse::<u32>().ok()?, if m.is_empty() { 0 } else { m.parse::<u32>().ok()? }),
        None if num.len() == 4 && suffix.is_none() => (num[..2].parse().ok()?, num[2..].parse().ok()?),
        None => (num.parse::<u32>().ok()?, 0),
    };
    if m > 59 {
        return None;
    }
    match suffix {
        Some(pm) => {
            if !(1..=12).contains(&h) {
                return None;
            }
            Some(((h % 12) + if pm { 12 } else { 0 }, m, true))
        }
        None if h > 23 => None,
        // "17:00", "08:30", "0" are unambiguous; "5" isn't.
        None => Some((h, m, h == 0 || h > 12 || num.starts_with('0'))),
    }
}

fn weekday(s: &str) -> Option<Weekday> {
    Some(match s {
        "mon" | "monday" => Weekday::Mon,
        "tue" | "tues" | "tuesday" => Weekday::Tue,
        "wed" | "wednesday" => Weekday::Wed,
        "thu" | "thur" | "thurs" | "thursday" => Weekday::Thu,
        "fri" | "friday" => Weekday::Fri,
        "sat" | "saturday" => Weekday::Sat,
        "sun" | "sunday" => Weekday::Sun,
        _ => return None,
    })
}

/// Local wall-clock time -> unix seconds (`None` in a DST gap).
pub fn to_unix(t: NaiveDateTime) -> Option<i64> {
    use chrono::TimeZone;
    chrono::Local.from_local_datetime(&t).earliest().map(|d| d.timestamp())
}

/// Unix seconds -> local wall-clock time.
pub fn from_unix(secs: i64) -> Option<NaiveDateTime> {
    use chrono::TimeZone;
    chrono::Local.timestamp_opt(secs, 0).single().map(|d| d.naive_local())
}

/// "today 17:00", "tomorrow 09:00", "Fri 9 Oct 12:00".
pub fn label(t: NaiveDateTime, now: NaiveDateTime) -> String {
    let days = (t.date() - now.date()).num_days();
    match days {
        0 => format!("today {}", t.format("%H:%M")),
        1 => format!("tomorrow {}", t.format("%H:%M")),
        _ => t.format("%a %-d %b %H:%M").to_string(),
    }
}

fn at(date: NaiveDate, h: u32, m: u32) -> NaiveDateTime {
    date.and_time(NaiveTime::from_hms_opt(h, m, 0).unwrap_or_default())
}

/// Parse `input` relative to `now` (local time). The result is always in
/// the future.
pub fn parse_when(input: &str, now: NaiveDateTime) -> Result<NaiveDateTime, String> {
    let lower = input.trim().to_lowercase().replace(',', " ");
    let mut s = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    let bad = || {
        format!(
            "I couldn't understand the time \"{}\"; try \"17:00\", \"tomorrow 9am\" or \"in 20 minutes\"",
            input.trim()
        )
    };
    if s.is_empty() {
        return Err(bad());
    }
    if let Some(d) = relative(&s) {
        return Ok(now + d);
    }
    // ISO: 2026-10-08 09:00 / 2026-10-08T09:00
    for fmt in ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(&s, fmt) {
            return if t > now { Ok(t) } else { Err("that time is already in the past".into()) };
        }
    }
    for filler in ["at ", "on ", "by ", "this "] {
        s = s.replacen(filler, "", 1).trim().to_string();
        s = s.replace(&format!(" {filler}"), " ");
    }
    // Split off a day word at the start (or the end: "9am tomorrow").
    let mut words: Vec<&str> = s.split_whitespace().collect();
    let mut day: Option<NaiveDate> = None;
    let mut explicit_today = false;
    let mut evening = false;
    let mut take_day = |w: &str| -> bool {
        let today = now.date();
        match w {
            "today" => {
                day = Some(today);
                explicit_today = true;
            }
            "tonight" => {
                day = Some(today);
                explicit_today = true;
                evening = true;
            }
            "tomorrow" | "tmrw" | "tomorow" => day = Some(today + Duration::days(1)),
            w => match weekday(w) {
                Some(wd) => {
                    let ahead =
                        (7 + wd.num_days_from_monday() as i64 - today.weekday().num_days_from_monday() as i64) % 7;
                    day = Some(today + Duration::days(if ahead == 0 { 7 } else { ahead }));
                }
                None => return false,
            },
        }
        true
    };
    words.retain(|w| *w != "next");
    if let Some(first) = words.first().copied() {
        if take_day(first) {
            words.remove(0);
        } else if let Some(last) = words.last().copied() {
            if take_day(last) {
                words.pop();
            }
        }
    }
    let rest = words.join(" ");
    let time = if rest.is_empty() {
        if evening {
            Some((20, 0, true))
        } else if day.is_some() {
            Some((DEFAULT_HOUR, 0, true))
        } else {
            None
        }
    } else {
        // "5 pm" -> "5pm"
        clock(&rest.replace(' ', ""))
    };
    let Some((h, m, sure)) = time else { return Err(bad()) };
    let date = day.unwrap_or(now.date());
    let candidates: Vec<NaiveDateTime> = if sure {
        vec![at(date, h, m)]
    } else if evening || h <= 6 {
        // Nobody means 5 in the morning: "at 5" is 17:00.
        vec![at(date, h + 12, m)]
    } else if day.is_some() && !explicit_today {
        // "tomorrow at 9": the morning one.
        vec![at(date, h, m)]
    } else {
        // "at 9" at 14:00 means 21:00; at 08:00 it means 09:00.
        vec![at(date, h, m), at(date, (h + 12) % 24, m)]
    };
    if let Some(t) = candidates.iter().copied().find(|t| *t > now) {
        return Ok(t);
    }
    if day.is_some() {
        return Err("that time has already passed today".into());
    }
    // A clock time that has passed today: the same time tomorrow.
    Ok(candidates[0] + Duration::days(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wednesday 7 Oct 2026, 14:00.
    fn now() -> NaiveDateTime {
        at(NaiveDate::from_ymd_opt(2026, 10, 7).unwrap(), 14, 0)
    }

    fn p(s: &str) -> String {
        parse_when(s, now()).map(|t| t.format("%a %d %H:%M").to_string()).unwrap_or_else(|e| format!("ERR {e}"))
    }

    #[test]
    fn clock_times() {
        assert_eq!(p("5"), "Wed 07 17:00");
        assert_eq!(p("at 5"), "Wed 07 17:00");
        assert_eq!(p("5pm"), "Wed 07 17:00");
        assert_eq!(p("5:30 pm"), "Wed 07 17:30");
        assert_eq!(p("17:00"), "Wed 07 17:00");
        assert_eq!(p("9"), "Wed 07 21:00");
        assert_eq!(p("9am"), "Thu 08 09:00");
        assert_eq!(p("13:00"), "Thu 08 13:00");
        assert_eq!(p("noon"), "Thu 08 12:00");
        assert_eq!(p("11.15"), "Wed 07 23:15");
        assert_eq!(p("2359"), "Wed 07 23:59");
    }

    #[test]
    fn days() {
        assert_eq!(p("tomorrow"), "Thu 08 09:00");
        assert_eq!(p("tomorrow at 9"), "Thu 08 09:00");
        assert_eq!(p("tomorrow 5"), "Thu 08 17:00");
        assert_eq!(p("9am tomorrow"), "Thu 08 09:00");
        assert_eq!(p("friday at noon"), "Fri 09 12:00");
        assert_eq!(p("on Monday 8:30"), "Mon 12 08:30");
        assert_eq!(p("wednesday 10am"), "Wed 14 10:00");
        assert_eq!(p("tonight"), "Wed 07 20:00");
        assert_eq!(p("tonight at 10"), "Wed 07 22:00");
        assert!(p("today at 9am").starts_with("ERR"));
        assert_eq!(p("2026-10-09 07:45"), "Fri 09 07:45");
    }

    #[test]
    fn relative_times() {
        assert_eq!(p("in 20 minutes"), "Wed 07 14:20");
        assert_eq!(p("in an hour"), "Wed 07 15:00");
        assert_eq!(p("in half an hour"), "Wed 07 14:30");
        assert_eq!(p("2h"), "Wed 07 16:00");
        assert_eq!(p("in 1.5 hours"), "Wed 07 15:30");
    }

    #[test]
    fn labels_and_unix_round_trip() {
        let n = now();
        assert_eq!(label(parse_when("5", n).unwrap(), n), "today 17:00");
        assert_eq!(label(parse_when("tomorrow 9am", n).unwrap(), n), "tomorrow 09:00");
        assert_eq!(label(parse_when("friday noon", n).unwrap(), n), "Fri 9 Oct 12:00");
        let t = parse_when("tomorrow 9am", n).unwrap();
        assert_eq!(from_unix(to_unix(t).unwrap()), Some(t));
    }

    #[test]
    fn nonsense_is_refused() {
        for bad in ["", "whenever", "25:00", "13pm", "5:75", "2020-01-01 10:00", "in -3 minutes"] {
            assert!(p(bad).starts_with("ERR"), "{bad}: {}", p(bad));
        }
    }
}
