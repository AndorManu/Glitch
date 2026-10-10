//! Games, play and growth: the settings for them, Glitch's mood and energy
//! (Tamagotchi-light), XP, levels and unlockables (hats, eye colours,
//! seasonal hats), the chat phrases that start a game, and the once-a-day
//! personal greeting built from his memory.
//!
//! Pure: every function takes the time ("unix seconds" + the local date) as
//! an argument, so it is unit-tested without a clock. `PetStore` keeps the
//! state in a small JSON file (`pet.json`) next to the settings.
//!
//! Never punishing or naggy: energy only drifts down to a floor (he gets
//! bored, never sick or sad), nothing is ever taken away, and he asks about
//! your projects at most once a day.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::memory::Fact;

// ------------------------------------------------------------------ settings

/// Settings → Features (games) and Settings → Wardrobe. Every field has a
/// default, so older settings files load fine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PlaySettings {
    /// Fetch: tray "Play fetch" / chat "let's play".
    pub fetch: bool,
    /// Hide and seek: tray / chat "hide and seek".
    pub hide_seek: bool,
    /// Drag a file onto Glitch and he eats it (moved into his belly folder). Off by default.
    pub feeding: bool,
    /// Mood & energy: hearts/stars on hover, bored = more mischief, happy = more dances.
    pub mood: bool,
    /// Personality growth: greets you by name, asks about your projects (needs memory on).
    pub growth: bool,
    /// Levels & wardrobe: XP, unlockable hats and eye colours.
    pub levels: bool,
    /// Ask before every meal (false = the user ticked "don't ask again").
    pub feed_confirm: bool,
    /// Glitch's belly: where eaten files are moved to. `None` = ask first.
    pub belly_dir: Option<String>,
    /// Chosen hat id (see [`HATS`]); `None` = no hat.
    pub hat: Option<String>,
    /// Glitch-eye colour id (see [`EYES`]).
    pub eye: String,
    /// Pumpkin hat around Halloween, Santa hat in December (when no hat is chosen).
    pub seasonal: bool,
}

impl Default for PlaySettings {
    fn default() -> Self {
        Self {
            fetch: true,
            hide_seek: true,
            feeding: false,
            mood: true,
            growth: true,
            levels: true,
            feed_confirm: true,
            belly_dir: None,
            hat: None,
            eye: "magenta".into(),
            seasonal: true,
        }
    }
}

// ------------------------------------------------------------- unlockables

pub const HATS: [&str; 8] = ["party", "wizard", "cap", "pumpkin", "santa", "crown", "cowboy", "headphones"];
pub const EYES: [&str; 4] = ["magenta", "cyan", "green", "gold"];
/// Hats that only come with the season (never by level).
pub const SEASONAL_HATS: [&str; 2] = ["pumpkin", "santa"];

/// XP needed for level 1, 2, 3... (index = level - 1).
pub const LEVELS: [u64; 12] = [0, 60, 160, 320, 540, 820, 1160, 1560, 2020, 2540, 3120, 3760];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UnlockKind {
    Hat,
    Eye,
}

/// What unlocks at which level.
pub const UNLOCKS: [(&str, UnlockKind, u32); 10] = [
    ("magenta", UnlockKind::Eye, 1),
    ("cyan", UnlockKind::Eye, 2),
    ("cap", UnlockKind::Hat, 3),
    ("party", UnlockKind::Hat, 4),
    ("green", UnlockKind::Eye, 5),
    ("headphones", UnlockKind::Hat, 6),
    ("cowboy", UnlockKind::Hat, 7),
    ("wizard", UnlockKind::Hat, 8),
    ("gold", UnlockKind::Eye, 10),
    ("crown", UnlockKind::Hat, 12),
];

pub fn level_for(xp: u64) -> u32 {
    LEVELS.iter().filter(|&&t| xp >= t).count() as u32
}

/// The seasonal hat for a local date "YYYY-MM-DD": the pumpkin from 24 Oct to
/// 2 Nov, the Santa hat in December.
pub fn season_hat(date: &str) -> Option<&'static str> {
    let mut parts = date.split('-').skip(1).map(|p| p.parse::<u32>().unwrap_or(0));
    let (m, d) = (parts.next()?, parts.next()?);
    match (m, d) {
        (10, 24..=31) | (11, 1..=2) => Some("pumpkin"),
        (12, _) => Some("santa"),
        _ => None,
    }
}

fn unlocked(id: &str, kind: UnlockKind, level: u32) -> bool {
    UNLOCKS.iter().any(|(i, k, l)| *i == id && *k == kind && *l <= level)
}

// --------------------------------------------------------------- the pet

/// Energy never drops below this (bored, never "dying").
pub const ENERGY_FLOOR: f64 = 12.0;
/// Energy drops one point per this many seconds without attention.
pub const DECAY_SECS: f64 = 240.0;
/// Most XP a day (so leaving the mouse on him all day doesn't level him up).
pub const DAILY_XP_CAP: u64 = 400;
/// Petting (hover) counts at most once per this many seconds.
pub const PET_EVERY_SECS: i64 = 90;

/// Things that happen to Glitch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PetEvent {
    /// A chat message.
    Chat,
    /// He brought the ball back.
    Fetch,
    /// Found in hide and seek.
    Found,
    /// Hide and seek: nobody found him, he gave up.
    GaveUp,
    /// Ate a file.
    Fed,
    /// The cursor rested on him.
    Pet,
    /// Picked up and thrown.
    Thrown,
}

impl PetEvent {
    /// (energy, xp)
    fn reward(self) -> (f64, u64) {
        match self {
            PetEvent::Chat => (4.0, 5),
            PetEvent::Fetch => (7.0, 10),
            PetEvent::Found => (9.0, 20),
            PetEvent::GaveUp => (4.0, 6),
            PetEvent::Fed => (10.0, 15),
            PetEvent::Pet => (1.5, 1),
            PetEvent::Thrown => (2.0, 1),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PetState {
    /// 0-100 as of `energy_at` (unix seconds); decays lazily.
    pub energy: f64,
    pub energy_at: i64,
    pub xp: u64,
    /// The local day the daily counters below belong to.
    pub day: String,
    /// When `day` started for him (the first event / load that day), unix s.
    pub day_start: i64,
    pub xp_today: u64,
    pub throws_today: u32,
    pub throws_yesterday: u32,
    pub fed_today: u32,
    pub last_pet: i64,
    /// The day of the last personal greeting (one a day).
    pub greeted_day: String,
    /// The memory fact he last asked about (asks about another one next time).
    pub asked_fact: Option<u64>,
}

impl Default for PetState {
    fn default() -> Self {
        Self {
            energy: 60.0,
            energy_at: 0,
            xp: 0,
            day: String::new(),
            day_start: 0,
            xp_today: 0,
            throws_today: 0,
            throws_yesterday: 0,
            fed_today: 0,
            last_pet: 0,
            greeted_day: String::new(),
            asked_fact: None,
        }
    }
}

/// What happened after an event: a level-up and what it unlocked.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Outcome {
    pub counted: bool,
    pub level_up: Option<u32>,
    pub unlocked: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mood {
    Bored,
    Content,
    Happy,
}

impl PetState {
    /// Energy now (decays towards the floor while ignored; never below it).
    pub fn energy_at(&self, now: i64) -> f64 {
        if self.energy_at == 0 || now <= self.energy_at {
            return self.energy;
        }
        let dropped = self.energy - (now - self.energy_at) as f64 / DECAY_SECS;
        dropped.max(ENERGY_FLOOR.min(self.energy)).clamp(0.0, 100.0)
    }

    pub fn mood(&self, now: i64) -> Mood {
        let e = self.energy_at(now);
        if e < 30.0 {
            Mood::Bored
        } else if e >= 70.0 {
            Mood::Happy
        } else {
            Mood::Content
        }
    }

    /// A new local day: yesterday's throws are remembered (suspicion), the
    /// daily counters start again. Only "yesterday" if it really was the day before.
    pub fn roll_day(&mut self, today: &str, now: i64) {
        if self.day == today {
            return;
        }
        let consecutive = !self.day.is_empty() && is_day_before(&self.day, today);
        self.throws_yesterday = if consecutive { self.throws_today } else { 0 };
        self.throws_today = 0;
        self.fed_today = 0;
        self.xp_today = 0;
        self.day = today.to_string();
        self.day_start = now;
    }

    /// 0-1: how suspicious he is today because he was thrown around a lot
    /// yesterday. Halves every 90 minutes after the day started.
    pub fn suspicion(&self, now: i64) -> f64 {
        if self.throws_yesterday < 3 {
            return 0.0;
        }
        let s0 = (self.throws_yesterday as f64 / 12.0).min(1.0);
        let hours = ((now - self.day_start).max(0)) as f64 / 3600.0;
        s0 * 0.5f64.powf(hours / 1.5)
    }

    /// Ate something today: chubbier until midnight.
    pub fn chubby(&self, today: &str) -> bool {
        self.day == today && self.fed_today > 0
    }

    pub fn level(&self) -> u32 {
        level_for(self.xp)
    }

    /// Record an event. Returns whether it counted and any level-up.
    pub fn record(&mut self, ev: PetEvent, today: &str, now: i64) -> Outcome {
        self.roll_day(today, now);
        if ev == PetEvent::Pet {
            if now - self.last_pet < PET_EVERY_SECS {
                return Outcome::default();
            }
            self.last_pet = now;
        }
        match ev {
            PetEvent::Thrown => self.throws_today += 1,
            PetEvent::Fed => self.fed_today += 1,
            _ => {}
        }
        let (de, dxp) = ev.reward();
        self.energy = (self.energy_at(now) + de).clamp(0.0, 100.0);
        self.energy_at = now;
        let before = self.level();
        let gain = dxp.min(DAILY_XP_CAP.saturating_sub(self.xp_today));
        self.xp += gain;
        self.xp_today += gain;
        let after = self.level();
        let mut out = Outcome { counted: true, ..Default::default() };
        if after > before {
            out.level_up = Some(after);
            out.unlocked = UNLOCKS
                .iter()
                .filter(|(_, _, l)| *l > before && *l <= after)
                .map(|(id, _, _)| id.to_string())
                .collect();
        }
        out
    }
}

fn parse_date(d: &str) -> Option<chrono::NaiveDate> {
    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()
}

fn is_day_before(a: &str, b: &str) -> bool {
    match (parse_date(a), parse_date(b)) {
        (Some(a), Some(b)) => b.signed_duration_since(a).num_days() == 1,
        _ => false,
    }
}

// --------------------------------------------------------------- the view

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UnlockInfo {
    pub id: String,
    pub kind: UnlockKind,
    /// Level it unlocks at (0 = seasonal only).
    pub level: u32,
    pub unlocked: bool,
}

/// Everything the mascot and the panel need ("pet-changed" event).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PetView {
    /// 0-100 (only meaningful with `mood_on`).
    pub energy: f64,
    pub mood: Mood,
    pub mood_on: bool,
    pub level: u32,
    pub xp: u64,
    /// XP where this level started / where the next one starts (None at the top).
    pub level_xp: u64,
    pub next_level_xp: Option<u64>,
    /// 0-1, see [`PetState::suspicion`].
    pub suspicion: f64,
    pub chubby: bool,
    /// What he wears right now (after levels, seasons and unlocks).
    pub hat: Option<String>,
    pub eye: String,
    pub season_hat: Option<String>,
    pub levels_on: bool,
    pub unlocks: Vec<UnlockInfo>,
}

pub fn view(p: &PetState, s: &PlaySettings, today: &str, now: i64) -> PetView {
    let level = p.level();
    let season = if s.seasonal { season_hat(today) } else { None };
    let hat = if !s.levels {
        None
    } else {
        match s.hat.as_deref() {
            Some(h) if unlocked(h, UnlockKind::Hat, level) || Some(h) == season => Some(h.to_string()),
            _ => season.map(str::to_string),
        }
    };
    let eye = if s.levels && unlocked(&s.eye, UnlockKind::Eye, level) { s.eye.clone() } else { "magenta".into() };
    let mut unlocks: Vec<UnlockInfo> = UNLOCKS
        .iter()
        .map(|(id, kind, l)| UnlockInfo { id: id.to_string(), kind: *kind, level: *l, unlocked: *l <= level })
        .collect();
    for h in SEASONAL_HATS {
        unlocks.push(UnlockInfo { id: h.into(), kind: UnlockKind::Hat, level: 0, unlocked: season == Some(h) });
    }
    let idx = (level as usize).clamp(1, LEVELS.len()) - 1;
    PetView {
        energy: (p.energy_at(now) * 10.0).round() / 10.0,
        mood: if s.mood { p.mood(now) } else { Mood::Content },
        mood_on: s.mood,
        level,
        xp: p.xp,
        level_xp: LEVELS[idx],
        next_level_xp: LEVELS.get(idx + 1).copied(),
        suspicion: if s.mood { (p.suspicion(now) * 100.0).round() / 100.0 } else { 0.0 },
        chubby: p.chubby(today),
        hat,
        eye,
        season_hat: season.map(str::to_string),
        levels_on: s.levels,
        unlocks,
    }
}

// --------------------------------------------------------------- storage

/// `pet.json`: Glitch's mood, energy and XP between sessions.
pub struct PetStore {
    pub state: PetState,
    path: Option<PathBuf>,
}

impl PetStore {
    pub fn in_memory() -> Self {
        Self { state: PetState::default(), path: None }
    }

    /// Missing or broken file: a fresh pet (a broken file is kept aside).
    pub fn load(path: &Path) -> Self {
        let state = match std::fs::read_to_string(path) {
            Err(_) => PetState::default(),
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| {
                let _ = std::fs::rename(path, path.with_extension("corrupt.json"));
                PetState::default()
            }),
        };
        Self { state, path: Some(path.to_path_buf()) }
    }

    pub fn save(&self) -> io::Result<()> {
        let Some(path) = &self.path else { return Ok(()) };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.state)?)?;
        std::fs::rename(&tmp, path)
    }
}

// ----------------------------------------------------------- chat phrases

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Game {
    Fetch,
    HideSeek,
}

/// A short chat message that asks for a game ("let's play", "hide and seek").
/// Longer messages (real questions that happen to mention fetch) go to the model.
/// Two clicks on him this close together (ms) are a double-click.
pub const DOUBLE_CLICK_MS: u64 = 380;

/// Is a click at `now_ms` the second of a double-click, given the previous
/// click's time (a double-click's second click never counts as a new first).
pub fn is_double_click(prev_ms: Option<u64>, now_ms: u64) -> bool {
    matches!(prev_ms, Some(p) if now_ms >= p && now_ms - p <= DOUBLE_CLICK_MS)
}

pub fn chat_game(text: &str) -> Option<Game> {
    let t: String = text
        .to_lowercase()
        .replace(['’', '\''], "")
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '&' { c } else { ' ' })
        .collect();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() || t.chars().count() > 40 {
        return None;
    }
    if t.contains("hide and seek") || t.contains("hide & seek") || t.contains("hide n seek") || t == "hide" {
        return Some(Game::HideSeek);
    }
    let fetch = ["lets play", "play fetch", "fetch", "play ball", "throw the ball", "wanna play", "want to play"];
    let asks = |p: &str| t == p || t.starts_with(&format!("{p} ")) || t.ends_with(&format!(" {p}"));
    if fetch.iter().any(|p| asks(p)) || t == "play" || t == "play with me" {
        return Some(Game::Fetch);
    }
    None
}

// ------------------------------------------------------ personal greeting

/// The user's name from a memory fact ("The user's name is Andor.", "User is
/// called Sam", "Their name is Kim").
pub fn name_from_facts(facts: &[Fact]) -> Option<String> {
    for f in facts.iter().rev() {
        let t = f.text.trim().trim_end_matches('.');
        let lower = t.to_lowercase();
        for key in ["name is ", "is called ", "goes by ", "call them ", "call me "] {
            let Some(i) = lower.find(key) else { continue };
            // Only about the user, not their dog.
            let before = &lower[..i];
            if !(before.contains("user")
                || before.contains("their")
                || before.contains("my")
                || before.trim().is_empty())
                || before.contains("dog")
                || before.contains("cat")
                || before.contains("pet")
            {
                continue;
            }
            let word: String = t[i + key.len()..].chars().take_while(|c| c.is_alphabetic() || *c == '-').collect();
            let ok = word.chars().count() >= 2
                && word.chars().count() <= 20
                && word.chars().next().is_some_and(|c| c.is_uppercase())
                && !["Unknown", "Not", "None"].contains(&word.as_str());
            if ok {
                return Some(word);
            }
        }
    }
    None
}

/// Something the user is working on, from a fact: (fact id, short subject).
/// "The user is working on the Bignesstec site." -> "the Bignesstec site".
pub fn projects_from_facts(facts: &[Fact]) -> Vec<(u64, String)> {
    let mut out = Vec::new();
    for f in facts {
        let t = f.text.trim().trim_end_matches('.');
        let lower = t.to_lowercase();
        let keys = [
            "working on ",
            "is building ",
            "are building ",
            "is making ",
            "is writing ",
            "is preparing ",
            "is launching ",
        ];
        let Some((i, key)) = keys.iter().find_map(|k| lower.find(k).map(|i| (i, *k))) else { continue };
        // About the user, not someone else in their life.
        let before = &lower[..i];
        let others =
            ["dog", "cat", "friend", "brother", "sister", "wife", "husband", "partner", "boss", "mother", "father"];
        if others.iter().any(|o| before.contains(o)) {
            continue;
        }
        let mut rest = t[i + key.len()..].trim().to_string();
        // Cut at a clause boundary.
        for cut in [",", ";", " because ", " which ", " that ", " for "] {
            if let Some(j) = rest.find(cut) {
                rest.truncate(j);
            }
        }
        let rest = rest.trim();
        let words: Vec<&str> = rest.split_whitespace().collect();
        if words.is_empty() || words.len() > 7 {
            continue;
        }
        let lower_first = words[0].to_lowercase();
        let subject = match lower_first.as_str() {
            "a" | "an" => format!("the {}", words[1..].join(" ")),
            "his" | "her" | "their" | "my" => format!("your {}", words[1..].join(" ")),
            "the" => rest.to_string(),
            _ => format!("the {rest}"),
        };
        if subject.split_whitespace().count() >= 2 {
            out.push((f.id, subject));
        }
    }
    out
}

/// At most once a day (the first time the chat opens): hello by name, a
/// question about one of their projects (a different one each time), and
/// a word about yesterday if he was thrown around a lot. `None` = the usual
/// greeting. Marks the day as done when it returns something.
pub fn personal_greeting(p: &mut PetState, facts: &[Fact], today: &str, now: i64, pick: f64) -> Option<String> {
    if p.greeted_day == today {
        return None;
    }
    let name = name_from_facts(facts);
    let projects = projects_from_facts(facts);
    let suspicious = p.suspicion(now) >= 0.35;
    if name.is_none() && projects.is_empty() && !suspicious {
        return None;
    }
    let hello = match &name {
        Some(n) => ["Hey {n}!", "Hi {n}!", "{n}! There you are."][(pick * 3.0) as usize % 3].replace("{n}", n),
        None => "Hey you!".to_string(),
    };
    let mut parts = vec![hello];
    if suspicious {
        parts.push("You threw me around a lot yesterday. I'm keeping an eye on you.".into());
    }
    // Another project than last time, if there is one.
    let choice = projects.iter().find(|(id, _)| Some(*id) != p.asked_fact).or(projects.first());
    if let Some((id, subject)) = choice {
        let q = ["How's {s} going?", "How did {s} go?", "Any news on {s}?"][(pick * 7.0) as usize % 3];
        parts.push(q.replace("{s}", subject));
        p.asked_fact = Some(*id);
    }
    p.greeted_day = today.to_string();
    Some(parts.join(" "))
}

#[cfg(test)]
mod tests {
    #[test]
    fn double_click_window() {
        assert!(super::is_double_click(Some(1000), 1300));
        assert!(!super::is_double_click(Some(1000), 1500));
        assert!(!super::is_double_click(None, 1000));
    }

    use super::*;

    fn fact(id: u64, text: &str) -> Fact {
        Fact { id, text: text.into(), added: "2026-10-01".into() }
    }

    #[test]
    fn defaults_and_old_files() {
        let s = PlaySettings::default();
        assert!(s.fetch && s.hide_seek && s.mood && s.growth && s.levels && s.seasonal && s.feed_confirm);
        assert!(!s.feeding, "feeding is off by default");
        assert_eq!(s.eye, "magenta");
        let partial: PlaySettings = serde_json::from_str(r#"{"feeding":true,"future":3}"#).unwrap();
        assert!(partial.feeding && partial.fetch);
    }

    #[test]
    fn energy_decays_to_a_floor_and_rises_with_play() {
        let mut p = PetState { energy: 50.0, energy_at: 1000, ..Default::default() };
        assert_eq!(p.energy_at(1000), 50.0);
        assert!((p.energy_at(1000 + 240 * 10) - 40.0).abs() < 1e-9);
        assert_eq!(p.energy_at(1000 + 240 * 1000), ENERGY_FLOOR);
        assert_eq!(p.mood(1000 + 240 * 1000), Mood::Bored);
        p.record(PetEvent::Fetch, "2026-10-07", 1000);
        assert_eq!(p.energy, 57.0);
        for _ in 0..10 {
            p.record(PetEvent::Found, "2026-10-07", 1000);
        }
        assert_eq!(p.energy, 100.0);
        assert_eq!(p.mood(1000), Mood::Happy);
    }

    #[test]
    fn xp_levels_and_unlocks() {
        let mut p = PetState::default();
        assert_eq!(p.level(), 1);
        let mut ups = vec![];
        for i in 0..30 {
            let o = p.record(PetEvent::Found, "2026-10-07", i);
            if let Some(l) = o.level_up {
                ups.push((l, o.unlocked));
            }
        }
        assert_eq!(p.xp, 400, "daily cap");
        assert_eq!(p.record(PetEvent::Found, "2026-10-07", 40).level_up, None);
        assert_eq!(ups[0], (2, vec!["cyan".to_string()]));
        assert_eq!(ups[1], (3, vec!["cap".to_string()]));
        // A new day: more XP.
        p.record(PetEvent::Chat, "2026-10-08", 90_000);
        assert_eq!(p.xp, 405);
    }

    #[test]
    fn petting_is_rate_limited() {
        let mut p = PetState::default();
        assert!(p.record(PetEvent::Pet, "2026-10-07", 1000).counted);
        assert!(!p.record(PetEvent::Pet, "2026-10-07", 1010).counted);
        assert!(p.record(PetEvent::Pet, "2026-10-07", 1000 + PET_EVERY_SECS).counted);
    }

    #[test]
    fn thrown_a_lot_yesterday_means_suspicious_today_then_it_fades() {
        let mut p = PetState::default();
        for i in 0..10 {
            p.record(PetEvent::Thrown, "2026-10-06", i);
        }
        assert_eq!(p.suspicion(100), 0.0, "today's throws don't count yet");
        p.roll_day("2026-10-07", 100_000);
        assert_eq!(p.throws_yesterday, 10);
        let s0 = p.suspicion(100_000);
        assert!(s0 > 0.8);
        assert!((p.suspicion(100_000 + 5400) - s0 / 2.0).abs() < 1e-9);
        assert!(p.suspicion(100_000 + 6 * 3600) < 0.1);
        // Not consecutive days: no grudge.
        let mut q = PetState { day: "2026-10-01".into(), throws_today: 20, ..Default::default() };
        q.roll_day("2026-10-07", 0);
        assert_eq!(q.throws_yesterday, 0);
    }

    #[test]
    fn chubby_only_on_the_day_he_ate() {
        let mut p = PetState::default();
        assert!(!p.chubby("2026-10-07"));
        p.record(PetEvent::Fed, "2026-10-07", 10);
        assert!(p.chubby("2026-10-07"));
        assert!(!p.chubby("2026-10-08"));
        p.roll_day("2026-10-08", 99_999);
        assert!(!p.chubby("2026-10-08"));
    }

    #[test]
    fn seasons() {
        assert_eq!(season_hat("2026-10-07"), None);
        assert_eq!(season_hat("2026-10-24"), Some("pumpkin"));
        assert_eq!(season_hat("2026-10-31"), Some("pumpkin"));
        assert_eq!(season_hat("2026-11-02"), Some("pumpkin"));
        assert_eq!(season_hat("2026-11-03"), None);
        assert_eq!(season_hat("2026-12-15"), Some("santa"));
        assert_eq!(season_hat("garbage"), None);
    }

    #[test]
    fn what_he_wears() {
        let mut s = PlaySettings { hat: Some("crown".into()), eye: "gold".into(), ..Default::default() };
        let mut p = PetState::default();
        // Locked: nothing / magenta.
        let v = view(&p, &s, "2026-10-07", 0);
        assert_eq!((v.hat, v.eye.as_str()), (None, "magenta"));
        p.xp = 5000;
        let v = view(&p, &s, "2026-10-07", 0);
        assert_eq!((v.hat.as_deref(), v.eye.as_str(), v.level), (Some("crown"), "gold", 12));
        assert_eq!(v.next_level_xp, None);
        // No hat chosen: the seasonal one, if seasonal is on.
        s.hat = None;
        assert_eq!(view(&p, &s, "2026-10-31", 0).hat.as_deref(), Some("pumpkin"));
        s.seasonal = false;
        assert_eq!(view(&p, &s, "2026-10-31", 0).hat, None);
        // Levels off: plain Glitch.
        s.levels = false;
        s.hat = Some("crown".into());
        let v = view(&p, &s, "2026-10-07", 0);
        assert_eq!((v.hat, v.eye.as_str()), (None, "magenta"));
        // Seasonal hats can't be chosen out of season.
        let s = PlaySettings { hat: Some("santa".into()), ..Default::default() };
        assert_eq!(view(&p, &s, "2026-07-01", 0).hat, None);
        assert_eq!(view(&p, &s, "2026-12-01", 0).hat.as_deref(), Some("santa"));
    }

    #[test]
    fn chat_phrases() {
        for t in ["let's play", "Lets play!", "play fetch", "fetch!", "wanna play?", "Let’s play fetch"] {
            assert_eq!(chat_game(t), Some(Game::Fetch), "{t}");
        }
        for t in ["hide and seek", "Let's play hide and seek!", "hide & seek?"] {
            assert_eq!(chat_game(t), Some(Game::HideSeek), "{t}");
        }
        for t in ["how do I fetch a git branch from origin quickly?", "open the play store", "playlist", ""] {
            assert_eq!(chat_game(t), None, "{t}");
        }
    }

    #[test]
    fn names_and_projects_from_memory() {
        let facts = vec![
            fact(1, "The user's dog is called Rex."),
            fact(2, "The user's name is Andor."),
            fact(3, "The user is working on the Bignesstec site."),
            fact(4, "The user is building a todo app called Tido, which is fun."),
            fact(5, "The user likes pizza."),
        ];
        assert_eq!(name_from_facts(&facts).as_deref(), Some("Andor"));
        assert_eq!(name_from_facts(&facts[..1]), None, "the dog is not the user");
        assert_eq!(name_from_facts(&[fact(1, "The user's name is Unknown.")]), None);
        let p = projects_from_facts(&facts);
        assert_eq!(p, vec![(3, "the Bignesstec site".to_string()), (4, "the todo app called Tido".to_string())]);
    }

    #[test]
    fn greeting_once_a_day_rotating_projects() {
        let facts = vec![
            fact(2, "The user's name is Andor."),
            fact(3, "The user is working on the Bignesstec site."),
            fact(4, "The user is building a game."),
        ];
        let mut p = PetState::default();
        let g = personal_greeting(&mut p, &facts, "2026-10-07", 0, 0.0).unwrap();
        assert_eq!(g, "Hey Andor! How's the Bignesstec site going?");
        assert_eq!(personal_greeting(&mut p, &facts, "2026-10-07", 10, 0.0), None, "once a day");
        let g = personal_greeting(&mut p, &facts, "2026-10-08", 90_000, 0.0).unwrap();
        assert!(g.contains("the game"), "{g}");
        // Nothing known: the usual greeting.
        let mut q = PetState::default();
        assert_eq!(personal_greeting(&mut q, &[fact(5, "The user likes pizza.")], "2026-10-07", 0, 0.5), None);
        assert_eq!(q.greeted_day, "");
    }

    #[test]
    fn store_round_trip_and_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pet.json");
        let mut s = PetStore::load(&path);
        assert_eq!(s.state, PetState::default());
        s.state.record(PetEvent::Fed, "2026-10-07", 5);
        s.save().unwrap();
        assert_eq!(PetStore::load(&path).state, s.state);
        std::fs::write(&path, "{ nope").unwrap();
        assert_eq!(PetStore::load(&path).state, PetState::default());
        assert!(path.with_extension("corrupt.json").exists());
    }
}
