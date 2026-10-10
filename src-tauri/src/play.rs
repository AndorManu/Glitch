//! Games, play and growth, the app side: Glitch's mood/energy/XP file
//! (`pet.json`), his belly (feeding: files are moved, never deleted, into a
//! folder the user picked, `belly.json` lists them for "restore"), the play
//! overlay the fetch ball lives in, the tray / chat entries that start a game, and the daily
//! personal greeting. The rules themselves are in `glitch_core::play` and
//! `glitch_core::belly` (unit-tested).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use glitch_core::belly::{Belly, BellyError, Eaten, MAX_PER_MEAL};
use glitch_core::play::{self, Game, PetEvent, PetStore, PetView, PlaySettings};
use glitch_core::settings::Settings;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindowBuilder, Window, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use crate::state::AppState;
use crate::windows;

/// The play overlay: an invisible, click-through layer over the work area
/// that the fetch ball is drawn on (playfield.html). No title bar, no
/// taskbar button, no Alt+Tab entry, never focused; it only catches the
/// mouse right over the ball (so you can grab it) and while you hold it.
pub const PLAYFIELD: &str = "playfield";

/// Where the ball is (physical px), for the mouse: grab it, hover glow.
#[derive(Debug, Default, Clone, Copy)]
pub struct BallHit {
    pub x: f64,
    pub y: f64,
    pub r: f64,
    pub shown: bool,
    pub held: bool,
}

pub struct PlayState {
    pub pet: Mutex<PetStore>,
    pub belly: Mutex<Belly>,
    pub ball: Mutex<BallHit>,
    poller: AtomicBool,
}

impl PlayState {
    pub fn new(config_dir: &std::path::Path) -> Self {
        Self {
            pet: Mutex::new(PetStore::load(&config_dir.join("pet.json"))),
            belly: Mutex::new(Belly::load(&config_dir.join("belly.json"))),
            ball: Mutex::new(BallHit::default()),
            poller: AtomicBool::new(false),
        }
    }
}

/// Commands that change things are only for the window that needs them
/// (the ball page, a note or a compromised page can't call them).
fn only_from(window: &Window, labels: &[&str]) -> Result<(), String> {
    if label_ok(window.label(), labels) {
        Ok(())
    } else {
        Err(format!("not allowed from the {} window", window.label()))
    }
}

fn label_ok(label: &str, labels: &[&str]) -> bool {
    labels.contains(&label)
}

fn now_secs() -> i64 {
    chrono::Local::now().timestamp()
}

fn today() -> String {
    glitch_core::memory::today()
}

fn pet_view(app: &AppHandle) -> PetView {
    let s = app.state::<AppState>().settings();
    let ps = app.state::<PlayState>();
    let mut pet = ps.pet.lock().unwrap();
    let (t, now) = (today(), now_secs());
    pet.state.roll_day(&t, now);
    play::view(&pet.state, &s.play, &t, now)
}

/// Something happened to Glitch: update and save his state, tell the windows.
pub fn record(app: &AppHandle, ev: PetEvent) -> PetView {
    let s = app.state::<AppState>().settings();
    let outcome = {
        let ps = app.state::<PlayState>();
        let mut pet = ps.pet.lock().unwrap();
        let out = pet.state.record(ev, &today(), now_secs());
        if out.counted {
            if let Err(e) = pet.save() {
                eprintln!("glitch: could not save pet.json: {e}");
            }
        }
        out
    };
    let v = pet_view(app);
    if outcome.counted {
        let _ = app.emit("pet-changed", &v);
    }
    if let (Some(level), true) = (outcome.level_up, s.play.levels) {
        let _ = app.emit("pet-levelup", LevelUp { level, unlocked: outcome.unlocked });
    }
    v
}

#[derive(Clone, Serialize)]
struct LevelUp {
    level: u32,
    unlocked: Vec<String>,
}

#[tauri::command]
pub fn pet_state(app: AppHandle) -> PetView {
    pet_view(&app)
}

/// From the mascot: "fetch", "found", "gave_up", "pet", "thrown".
#[tauri::command]
pub fn pet_event(app: AppHandle, window: Window, kind: PetEvent) -> Result<PetView, String> {
    only_from(&window, &[windows::MASCOT])?;
    // Feeding and chatting are only counted here in Rust.
    if matches!(kind, PetEvent::Fed | PetEvent::Chat) {
        return Ok(pet_view(&app));
    }
    Ok(record(&app, kind))
}

/// Fields of [`PlaySettings`] the panel may change; missing = unchanged.
#[derive(Deserialize, Default)]
pub struct PlayPatch {
    fetch: Option<bool>,
    hide_seek: Option<bool>,
    feeding: Option<bool>,
    mood: Option<bool>,
    growth: Option<bool>,
    levels: Option<bool>,
    feed_confirm: Option<bool>,
    seasonal: Option<bool>,
    /// "" = no hat.
    hat: Option<String>,
    eye: Option<String>,
}

fn apply(p: &mut PlaySettings, patch: PlayPatch) {
    let set = |dst: &mut bool, v: Option<bool>| {
        if let Some(v) = v {
            *dst = v;
        }
    };
    set(&mut p.fetch, patch.fetch);
    set(&mut p.hide_seek, patch.hide_seek);
    set(&mut p.feeding, patch.feeding);
    set(&mut p.mood, patch.mood);
    set(&mut p.growth, patch.growth);
    set(&mut p.levels, patch.levels);
    set(&mut p.feed_confirm, patch.feed_confirm);
    set(&mut p.seasonal, patch.seasonal);
    if let Some(h) = patch.hat {
        p.hat = play::HATS.contains(&h.as_str()).then_some(h);
    }
    if let Some(e) = patch.eye.filter(|e| play::EYES.contains(&e.as_str())) {
        p.eye = e;
    }
}

/// Settings -> Features / Wardrobe: only the settings panel may change these
/// (including feeding and its "don't ask again").
#[tauri::command]
pub fn update_play_settings(app: AppHandle, window: Window, patch: PlayPatch) -> Result<Settings, String> {
    only_from(&window, &[windows::PANEL])?;
    let new = app.state::<AppState>().update_settings(|s| apply(&mut s.play, patch));
    let _ = app.emit("settings-changed", &new);
    let _ = app.emit("pet-changed", pet_view(&app));
    Ok(new)
}

// ------------------------------------------------------------------ games

/// Tray "Play fetch" / "Hide and seek", or the chat: close the chat (he
/// can't play while it is open) and tell the mascot.
pub fn start_game(app: &AppHandle, game: Game) {
    let s = app.state::<AppState>().settings();
    let on = match game {
        Game::Fetch => s.play.fetch,
        Game::HideSeek => s.play.hide_seek,
    };
    if !on {
        return;
    }
    windows::hide_bubble(app);
    windows::hide_panel(app);
    let name = match game {
        Game::Fetch => "play:fetch",
        Game::HideSeek => "play:hide",
    };
    let _ = app.emit("mascot-action", name);
}

/// A short chat message asking for a game: answered here, no model involved.
pub fn chat_hook(app: &AppHandle, text: &str) -> Option<glitch_core::agent::Step> {
    let game = play::chat_game(text)?;
    let s = app.state::<AppState>().settings().play;
    let (on, reply) = match game {
        Game::Fetch => (s.fetch, "Yesss! Grab the ball and flick it, I'll bring it back!"),
        Game::HideSeek => (s.hide_seek, "Okay! Close your eyes... no peeking! Find me: point at me when you spot me."),
    };
    if !on {
        return None;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Let the answer show for a moment, then the chat gets out of the way.
        tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
        start_game(&app, game);
    });
    Some(glitch_core::agent::Step::Reply { text: reply.into(), actions: vec![] })
}

/// Fetch starts: the play overlay over the work area of Glitch's screen,
/// created hidden; the page shows it (`playfield_ready`) once it has drawn.
#[tauri::command]
pub async fn ball_open(app: AppHandle, window: Window) -> bool {
    if only_from(&window, &[windows::MASCOT]).is_err() || !app.state::<AppState>().settings().play.fetch {
        return false;
    }
    let Some(mascot) = app.get_webview_window(windows::MASCOT) else { return false };
    let Some(area) = windows::work_area_of(&mascot) else { return false };
    let win = match app.get_webview_window(PLAYFIELD) {
        Some(w) => w,
        None => match WebviewWindowBuilder::new(&app, PLAYFIELD, WebviewUrl::App("playfield.html".into()))
            .title("Glitch play")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .accept_first_mouse(true)
            .visible(false)
            .build()
        {
            Ok(w) => w,
            Err(e) => {
                eprintln!("glitch: play overlay failed: {e}");
                return false;
            }
        },
    };
    #[cfg(target_os = "windows")]
    if let Ok(h) = win.hwnd() {
        crate::play_native::make_tool_window(h.0 as isize);
    }
    let _ = win.set_position(PhysicalPosition::new(area.x, area.y));
    let _ = win.set_size(PhysicalSize::new(area.w as u32, area.h as u32));
    let _ = win.set_ignore_cursor_events(true);
    app.state::<PlayState>().ball.lock().unwrap().shown = true;
    let _ = win.emit("ball-begin", ());
    start_poller(&app);
    true
}

#[derive(Deserialize)]
pub struct BallFrame {
    /// Centre and radius in physical screen px (for the mouse).
    x: f64,
    y: f64,
    r: f64,
    /// What to draw (playfield.ts BallPicture), passed on as is.
    pic: serde_json::Value,
}

/// A new picture of the ball (the mascot runs its physics).
#[tauri::command]
pub fn ball_frame(app: AppHandle, window: Window, frame: BallFrame) {
    if only_from(&window, &[windows::MASCOT]).is_err() {
        return;
    }
    {
        let ps = app.state::<PlayState>();
        let mut b = ps.ball.lock().unwrap();
        b.x = frame.x;
        b.y = frame.y;
        b.r = frame.r;
    }
    let _ = app.emit_to(PLAYFIELD, "ball-frame", frame.pic);
}

/// Fetch is over: the ball pops into pixels, then the overlay goes away (`playfield_idle`).
#[tauri::command]
pub fn ball_close(app: AppHandle, window: Window) {
    if only_from(&window, &[windows::MASCOT]).is_err() {
        return;
    }
    let _ = app.emit_to(PLAYFIELD, "ball-end", ());
    let ps = app.state::<PlayState>();
    let mut b = ps.ball.lock().unwrap();
    b.held = false;
}

/// The overlay page drew its first frame: show it without taking focus.
#[tauri::command]
pub fn playfield_ready(app: AppHandle, window: Window) {
    if only_from(&window, &[PLAYFIELD]).is_err() {
        return;
    }
    let Some(win) = app.get_webview_window(PLAYFIELD) else { return };
    if !app.state::<PlayState>().ball.lock().unwrap().shown {
        return;
    }
    let _ = win.set_ignore_cursor_events(true);
    crate::chaos::show_quietly(&win);
    #[cfg(target_os = "windows")]
    if let Ok(h) = win.hwnd() {
        crate::play_native::make_tool_window(h.0 as isize);
    }
    // Glitch stays above his ball.
    if let Some(m) = app.get_webview_window(windows::MASCOT) {
        let _ = m.set_always_on_top(true);
    }
}

/// The ball has popped away: hide the overlay, stop watching the mouse.
#[tauri::command]
pub fn playfield_idle(app: AppHandle, window: Window) {
    if only_from(&window, &[PLAYFIELD]).is_err() {
        return;
    }
    app.state::<PlayState>().ball.lock().unwrap().shown = false;
    if let Some(w) = app.get_webview_window(PLAYFIELD) {
        let _ = w.set_ignore_cursor_events(true);
        let _ = w.hide();
    }
}

/// The page: the ball was pressed / let go (keeps the overlay catching the mouse meanwhile).
#[tauri::command]
pub fn ball_hold(app: AppHandle, window: Window, held: bool) {
    if only_from(&window, &[PLAYFIELD]).is_err() {
        return;
    }
    app.state::<PlayState>().ball.lock().unwrap().held = held;
}

/// Is the cursor on the ball (with a small margin)? Physical px.
pub fn on_ball(b: &BallHit, cursor: (f64, f64), margin: f64) -> bool {
    b.shown && b.r > 0.0 && (cursor.0 - b.x).hypot(cursor.1 - b.y) <= b.r + margin
}

/// While the overlay is up: let the mouse through except over the ball (and
/// while it is held), tell the mascot about hovering, and (Windows) notice a
/// release the page missed. 60 Hz near the ball, nothing once fetch ends.
fn start_poller(app: &AppHandle) {
    let ps = app.state::<PlayState>();
    if ps.poller.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut catching = false;
        let mut hover = false;
        let mut up_polls = 0;
        loop {
            std::thread::sleep(Duration::from_millis(16));
            let ps = app.state::<PlayState>();
            let b = *ps.ball.lock().unwrap();
            let Some(win) = app.get_webview_window(PLAYFIELD) else { break };
            if !b.shown {
                if catching {
                    let _ = win.set_ignore_cursor_events(true);
                }
                break;
            }
            let scale = win.scale_factor().unwrap_or(1.0);
            let cursor = crate::play_native::cursor().or_else(|| app.cursor_position().ok().map(|p| (p.x, p.y)));
            let Some(cursor) = cursor else { continue };
            let over = on_ball(&b, cursor, 8.0 * scale);
            if b.held {
                // Windows: the button is up but the page never said so (it lost the pointer).
                if crate::play_native::left_down() == Some(false) {
                    up_polls += 1;
                    if up_polls >= 3 {
                        ps.ball.lock().unwrap().held = false;
                        let _ = app.emit_to(windows::MASCOT, "ball-release", ());
                    }
                } else {
                    up_polls = 0;
                }
            } else {
                up_polls = 0;
            }
            let want = over || b.held;
            if want != catching {
                catching = want;
                let _ = win.set_ignore_cursor_events(!want);
            }
            if over != hover {
                hover = over;
                let _ = app.emit_to(windows::MASCOT, "ball-hover", over);
                let _ = app.emit_to(PLAYFIELD, "ball-hover", over);
            }
        }
        if hover {
            let _ = app.emit_to(windows::MASCOT, "ball-hover", false);
        }
        app.state::<PlayState>().poller.store(false, Ordering::SeqCst);
    });
}

// ----------------------------------------------------------------- growth

/// The once-a-day personal hello for the chat bubble (None = the usual one).
#[tauri::command]
pub async fn growth_greeting(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    only_from(&window, &[windows::BUBBLE])?;
    let s = state.settings();
    if !s.play.growth || !s.memory_enabled {
        return Ok(None);
    }
    let facts = {
        let agent = state.agent.lock().await;
        agent.memory().map(|m| m.data.facts.clone()).unwrap_or_default()
    };
    let ps = app.state::<PlayState>();
    let mut pet = ps.pet.lock().unwrap();
    let pick = (now_secs() % 997) as f64 / 997.0;
    let g = play::personal_greeting(&mut pet.state, &facts, &today(), now_secs(), pick);
    if g.is_some() {
        let _ = pet.save();
    }
    Ok(g)
}

// ------------------------------------------------------------------ belly

#[derive(Serialize)]
pub struct BellyView {
    dir: Option<String>,
    items: Vec<Eaten>,
}

#[tauri::command]
pub fn belly_list(app: AppHandle) -> BellyView {
    let dir = app.state::<AppState>().settings().play.belly_dir;
    let items = app.state::<PlayState>().belly.lock().unwrap().data.items.clone();
    BellyView { dir, items }
}

/// Put an eaten file back where it came from.
#[tauri::command]
pub fn belly_restore(app: AppHandle, window: Window, id: u64) -> Result<String, String> {
    only_from(&window, &[windows::PANEL])?;
    let dir = app.state::<AppState>().settings().play.belly_dir.ok_or("I haven't eaten anything yet")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let r = {
        let ps = app.state::<PlayState>();
        let mut b = ps.belly.lock().unwrap();
        let r = b.restore(id, &PathBuf::from(dir), &home);
        let _ = b.save();
        r
    };
    let _ = app.emit("belly-changed", ());
    r.map(|p| p.display().to_string()).map_err(|e| e.to_string())
}

/// Ask for the belly folder (native folder picker). Saves and returns it.
fn pick_folder(app: &AppHandle) -> Option<PathBuf> {
    let start = app.path().document_dir().ok();
    let mut d = app.dialog().file().set_title("Pick a folder for Glitch's belly (eaten files are moved here)");
    if let Some(dir) = start {
        d = d.set_directory(dir);
    }
    let picked = d.blocking_pick_folder()?.into_path().ok()?;
    let s = app.state::<AppState>().update_settings(|s| s.play.belly_dir = Some(picked.display().to_string()));
    let _ = app.emit("settings-changed", &s);
    Some(picked)
}

#[tauri::command]
pub async fn belly_choose_folder(app: AppHandle, window: Window) -> Option<String> {
    only_from(&window, &[windows::PANEL]).ok()?;
    let a = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || pick_folder(&a)).await.ok().flatten();
    let _ = app.emit("belly-changed", ());
    r.map(|p| p.display().to_string())
}

#[derive(Clone, Serialize, Default)]
pub struct FeedResult {
    /// File names he ate.
    eaten: Vec<String>,
    /// Why some weren't eaten.
    refused: Vec<String>,
    /// The user said no (or closed a dialog).
    declined: bool,
}

fn size_text(n: u64) -> String {
    match n {
        n if n >= 1 << 30 => format!("{:.1} GB", n as f64 / (1u64 << 30) as f64),
        n if n >= 1 << 20 => format!("{:.1} MB", n as f64 / (1u64 << 20) as f64),
        n if n >= 1 << 10 => format!("{} KB", n >> 10),
        n => format!("{n} bytes"),
    }
}

/// Files dropped on Glitch. Only the native drag-and-drop event of the
/// mascot window feeds him (no page can hand Rust a path to eat), and only
/// when the drop lands on his body. Enter/leave tell the page, so he can open
/// his mouth.
pub fn watch_drops(app: &AppHandle) {
    let Some(m) = app.get_webview_window(windows::MASCOT) else { return };
    let handle = app.clone();
    m.on_window_event(move |e| {
        let WindowEvent::DragDrop(d) = e else { return };
        if !handle.state::<AppState>().settings().play.feeding {
            return;
        }
        match d {
            DragDropEvent::Enter { .. } | DragDropEvent::Over { .. } => {
                let _ = handle.emit_to(windows::MASCOT, "feed-drag", true);
            }
            DragDropEvent::Leave => {
                let _ = handle.emit_to(windows::MASCOT, "feed-drag", false);
            }
            DragDropEvent::Drop { paths, position } => {
                let _ = handle.emit_to(windows::MASCOT, "feed-drag", false);
                if !on_body(&handle, position.x, position.y) {
                    return;
                }
                let (app, paths) = (handle.clone(), paths.clone());
                tauri::async_runtime::spawn(async move {
                    let _ = app.emit_to(windows::MASCOT, "feed-start", ());
                    let a = app.clone();
                    let r = tauri::async_runtime::spawn_blocking(move || feed_blocking(&a, paths))
                        .await
                        .unwrap_or_default();
                    let _ = app.emit_to(windows::MASCOT, "feed-result", &r);
                });
            }
            _ => {}
        }
    });
}

/// Is a window-local physical point on his body (the click-through hitbox)?
fn on_body(app: &AppHandle, x: f64, y: f64) -> bool {
    let hb = app.state::<crate::hover::Hitbox>();
    let body = (*hb.body.lock().unwrap()).or(*hb.last_body.lock().unwrap());
    let Some(g) = *hb.geometry.lock().unwrap() else { return false };
    crate::hover::hit((x, y), (0.0, 0.0, g.w, g.h), body, g.scale)
}

fn feed_blocking(app: &AppHandle, paths: Vec<PathBuf>) -> FeedResult {
    let mut out = FeedResult::default();
    let settings = app.state::<AppState>().settings();
    if !settings.play.feeding || paths.is_empty() {
        out.declined = true;
        return out;
    }
    let dir = match settings.play.belly_dir.clone().map(PathBuf::from) {
        Some(d) => d,
        None => {
            let ok = app
                .dialog()
                .message(
                    "Yum! Before I eat anything: where should my belly be?\n\nPick a folder. Everything I eat is MOVED \
                     there (never deleted), and Settings → Glitch's belly can put each file back.",
                )
                .title("Glitch's belly")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom("Choose a folder".into(), "Not now".into()))
                .blocking_show();
            match ok.then(|| pick_folder(app)).flatten() {
                Some(d) => d,
                None => {
                    out.declined = true;
                    return out;
                }
            }
        }
    };
    let Ok(home) = app.path().home_dir() else {
        out.declined = true;
        return out;
    };
    let mut edible: Vec<(PathBuf, u64)> = Vec::new();
    for p in paths.iter().take(MAX_PER_MEAL) {
        match Belly::check(p, &dir, &home) {
            Ok(size) => edible.push((p.clone(), size)),
            Err(e) => out.refused.push(e.to_string()),
        }
    }
    if paths.len() > MAX_PER_MEAL {
        out.refused.push(format!("Only {MAX_PER_MEAL} files at a time, I'm not a bin!"));
    }
    if edible.is_empty() {
        return out;
    }
    if settings.play.feed_confirm {
        let what = match edible.as_slice() {
            [(p, size)] => format!(
                "{} ({})",
                p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                size_text(*size)
            ),
            many => format!("these {} files", many.len()),
        };
        let r = app
            .dialog()
            .message(format!(
                "Can I eat {what}?\n\nIt is MOVED (not deleted) into my belly:\n{}\n\nYou can put it back any time in \
                 Settings → Glitch's belly.",
                dir.display()
            ))
            .title("Feed Glitch?")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                "Eat it".into(),
                "Eat it, don't ask again".into(),
                "Nope".into(),
            ))
            .blocking_show_with_result();
        let answer = match &r {
            MessageDialogResult::Custom(label) => label.as_str(),
            MessageDialogResult::Yes => "Eat it",
            MessageDialogResult::No => "Eat it, don't ask again",
            _ => "Nope",
        };
        match answer {
            "Eat it" => {}
            "Eat it, don't ask again" => {
                let s = app.state::<AppState>().update_settings(|s| s.play.feed_confirm = false);
                let _ = app.emit("settings-changed", &s);
            }
            _ => {
                out.declined = true;
                return out;
            }
        }
    }
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    for (p, _) in edible {
        let r: Result<Eaten, BellyError> = {
            let ps = app.state::<PlayState>();
            let mut b = ps.belly.lock().unwrap();
            let r = b.eat(&p, &dir, &home, &stamp);
            if let Err(e) = b.save() {
                eprintln!("glitch: could not save belly.json: {e}");
            }
            r
        };
        match r {
            Ok(e) => {
                out.eaten.push(e.name);
                record(app, PetEvent::Fed);
            }
            Err(e) => out.refused.push(e.to_string()),
        }
    }
    let _ = app.emit("belly-changed", ());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_only_accept_known_hats_and_eyes() {
        let mut p = PlaySettings::default();
        apply(
            &mut p,
            PlayPatch {
                hat: Some("crown".into()),
                eye: Some("gold".into()),
                feeding: Some(true),
                ..Default::default()
            },
        );
        assert_eq!((p.hat.as_deref(), p.eye.as_str(), p.feeding), (Some("crown"), "gold", true));
        apply(&mut p, PlayPatch { hat: Some("".into()), eye: Some("rainbow".into()), ..Default::default() });
        assert_eq!((p.hat, p.eye.as_str()), (None, "gold"));
    }

    #[test]
    fn commands_are_per_window() {
        // Settings (incl. feeding and "don't ask again") and restores: the panel only.
        assert!(label_ok("panel", &[windows::PANEL]));
        for other in ["mascot", "bubble", "playfield", "note", "pawprints", "Panel", ""] {
            assert!(!label_ok(other, &[windows::PANEL]), "{other}");
        }
        assert!(label_ok("mascot", &[windows::MASCOT]));
        assert!(!label_ok("playfield", &[windows::MASCOT]));
    }

    #[test]
    fn the_ball_catches_the_mouse_only_on_itself() {
        let b = BallHit { x: 100.0, y: 100.0, r: 9.0, shown: true, held: false };
        assert!(on_ball(&b, (100.0, 100.0), 8.0));
        assert!(on_ball(&b, (116.0, 100.0), 8.0));
        assert!(!on_ball(&b, (118.0, 100.0), 8.0));
        assert!(!on_ball(&BallHit { shown: false, ..b }, (100.0, 100.0), 8.0));
    }

    #[test]
    fn sizes() {
        assert_eq!(size_text(12), "12 bytes");
        assert_eq!(size_text(2048), "2 KB");
        assert_eq!(size_text(3 << 20), "3.0 MB");
    }
}
