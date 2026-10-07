//! A scriptable fake desktop for app control: apps with UI trees that
//! change when things are clicked, slow starts, windows behind others,
//! minimized windows, lists that need scrolling, dialogs that pop up.
//! Used by the unit tests and by the live model eval
//! (`examples/live_eval.rs`), so the agent loop can be tested against a real
//! model without touching any real app.

use std::sync::Mutex;
use std::time::Duration;

use super::{Hands, HandsResult, Key, Media, MediaStatus, UiElement, WindowRef};

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    None,
    /// Show another screen of the app.
    Goto(&'static str),
    /// Start playing (title, artist, context such as a playlist name).
    Play {
        title: &'static str,
        artist: &'static str,
        context: &'static str,
    },
    /// Pause what's playing.
    Pause,
    /// Close the dialog.
    Dismiss,
}

#[derive(Debug, Clone)]
pub struct MockEl {
    pub role: &'static str,
    pub name: String,
    pub value: Option<String>,
    pub effect: Effect,
    /// Only exists after the window was scrolled down (virtualised lists).
    pub below_fold: bool,
    pub password: bool,
    pub editable: bool,
}

pub fn el(role: &'static str, name: &str) -> MockEl {
    MockEl {
        role,
        name: name.into(),
        value: None,
        effect: Effect::None,
        below_fold: false,
        password: false,
        editable: matches!(role, "edit" | "document"),
    }
}

impl MockEl {
    pub fn on_click(mut self, e: Effect) -> Self {
        self.effect = e;
        self
    }
    pub fn below_fold(mut self) -> Self {
        self.below_fold = true;
        self
    }
    pub fn password(mut self) -> Self {
        self.password = true;
        self
    }
}

#[derive(Debug, Clone)]
pub struct MockApp {
    /// Name used by open_app / the platform ("Spotify").
    pub app: &'static str,
    pub exe: &'static str,
    pub title: String,
    pub open: bool,
    pub launched: bool,
    /// Window polls after launch before the window shows up (slow start).
    pub appear_after: u32,
    polls: u32,
    /// Reads that return an empty tree first (Chromium waking its accessibility).
    pub empty_reads: u32,
    pub minimized: bool,
    /// Comes up behind the window in front instead of on top.
    pub opens_behind: bool,
    pub screens: Vec<(&'static str, Vec<MockEl>)>,
    pub screen: &'static str,
    pub scrolled: bool,
    pub dialog: Option<(String, Vec<MockEl>)>,
    /// A dialog that pops up the first time Glitch types.
    pub dialog_on_type: Option<(String, Vec<MockEl>)>,
    /// The title follows what's playing (Spotify does).
    pub title_shows_playing: bool,
}

impl MockApp {
    pub fn new(app: &'static str, exe: &'static str, title: &str, screens: Vec<(&'static str, Vec<MockEl>)>) -> Self {
        let screen = screens.first().map(|s| s.0).unwrap_or("main");
        Self {
            app,
            exe,
            title: title.into(),
            open: false,
            launched: false,
            appear_after: 0,
            polls: 0,
            empty_reads: 0,
            minimized: false,
            opens_behind: false,
            screens,
            screen,
            scrolled: false,
            dialog: None,
            dialog_on_type: None,
            title_shows_playing: false,
        }
    }
    pub fn already_open(mut self) -> Self {
        self.open = true;
        self
    }
}

#[derive(Default)]
pub struct MockState {
    pub apps: Vec<MockApp>,
    /// Index of the app in front.
    pub front: Option<usize>,
    pub playing: Option<(MediaStatus, &'static str)>,
    /// What happened, in order (clicks, typing, keys, media, links).
    pub log: Vec<String>,
    pub driving: Option<String>,
    /// Every drive() call (banner on/off), for tests.
    pub drive_log: Vec<Option<String>>,
    /// Simulate the user grabbing the mouse after this many control actions.
    pub interrupt_after: Option<u32>,
    pub actions: u32,
    pub interrupted: bool,
}

/// The fake: apps live in a mutex, every call is recorded.
#[derive(Default)]
pub struct MockHands {
    pub state: Mutex<MockState>,
}

fn win_id(i: usize, dialog: bool) -> u64 {
    (i as u64 + 1) * 10 + u64::from(dialog)
}

impl MockHands {
    pub fn new(apps: Vec<MockApp>) -> Self {
        let front = apps.iter().position(|a| a.open && !a.minimized);
        Self { state: Mutex::new(MockState { apps, front, ..Default::default() }) }
    }

    /// The platform launched an app (open_app): it appears after a while.
    pub fn launch(&self, name: &str) -> bool {
        let mut s = self.state.lock().unwrap();
        let Some(i) = s.apps.iter().position(|a| a.app.eq_ignore_ascii_case(name)) else { return false };
        s.log.push(format!("launch {name}"));
        let a = &mut s.apps[i];
        if a.open {
            a.minimized = false;
            s.front = Some(i);
        } else {
            a.launched = true;
            a.polls = 0;
        }
        true
    }

    pub fn log(&self) -> Vec<String> {
        self.state.lock().unwrap().log.clone()
    }

    /// (title, context) of what's playing.
    pub fn playing(&self) -> Option<(String, String)> {
        let s = self.state.lock().unwrap();
        s.playing.as_ref().filter(|(m, _)| m.playing).map(|(m, c)| (m.title.clone(), c.to_string()))
    }

    /// The value of the first editable element of an app.
    pub fn text_of(&self, app: &str) -> Option<String> {
        let s = self.state.lock().unwrap();
        let a = s.apps.iter().find(|a| a.app == app)?;
        let (_, els) = a.screens.iter().find(|(n, _)| *n == a.screen)?;
        els.iter().find(|e| e.editable).and_then(|e| e.value.clone())
    }

    fn index_of(s: &MockState, w: &WindowRef) -> HandsResult<(usize, bool)> {
        let i = (w.id / 10) as usize;
        let dialog = w.id % 10 == 1;
        if i == 0 || i > s.apps.len() || !s.apps[i - 1].open {
            return Err("that window has closed".into());
        }
        if dialog && s.apps[i - 1].dialog.is_none() {
            return Err("that dialog has closed".into());
        }
        Ok((i - 1, dialog))
    }

    fn visible_elements(a: &MockApp, dialog: bool) -> Vec<(u64, &MockEl)> {
        if dialog {
            return a
                .dialog
                .as_ref()
                .map(|(_, els)| els.iter().enumerate().map(|(j, e)| (900 + j as u64, e)).collect())
                .unwrap_or_default();
        }
        let Some((si, (_, els))) = a.screens.iter().enumerate().find(|(_, (n, _))| *n == a.screen) else {
            return vec![];
        };
        els.iter()
            .enumerate()
            .filter(|(_, e)| !e.below_fold || a.scrolled)
            .map(|(j, e)| (((si as u64) << 16) | j as u64, e))
            .collect()
    }

    fn count_action(s: &mut MockState) {
        s.actions += 1;
        if s.interrupt_after.is_some_and(|n| s.actions >= n) {
            s.interrupted = true;
        }
    }

    fn element_mut<'a>(a: &'a mut MockApp, key: u64) -> Option<&'a mut MockEl> {
        if key >= 900 && key < 1000 {
            return a.dialog.as_mut().and_then(|(_, els)| els.get_mut((key - 900) as usize));
        }
        let (si, j) = ((key >> 16) as usize, (key & 0xffff) as usize);
        a.screens.get_mut(si).and_then(|(_, els)| els.get_mut(j))
    }

    fn apply(s: &mut MockState, i: usize, effect: Effect) {
        match effect {
            Effect::None => {}
            Effect::Goto(screen) => {
                s.apps[i].screen = screen;
                s.apps[i].scrolled = false;
            }
            Effect::Play { title, artist, context } => {
                let app = s.apps[i].app.to_string();
                s.playing =
                    Some((MediaStatus { app, title: title.into(), artist: artist.into(), playing: true }, context));
                let a = &mut s.apps[i];
                if a.title_shows_playing {
                    a.title = format!("{title} - {artist}");
                }
                // "Play X" buttons turn into "Pause X".
                for (_, els) in &mut a.screens {
                    for e in els.iter_mut() {
                        if let Some(rest) = e.name.strip_prefix("Play ") {
                            if rest == context || e.name == "Play" {
                                e.name = format!("Pause {rest}");
                                e.effect = Effect::Pause;
                            }
                        }
                    }
                }
            }
            Effect::Pause => {
                if let Some((m, _)) = &mut s.playing {
                    m.playing = false;
                }
            }
            Effect::Dismiss => s.apps[i].dialog = None,
        }
    }
}

impl Hands for MockHands {
    fn windows(&self) -> Vec<WindowRef> {
        let mut s = self.state.lock().unwrap();
        let mut newly_open = None;
        for (i, a) in s.apps.iter_mut().enumerate() {
            if a.launched && !a.open {
                a.polls += 1;
                if a.polls > a.appear_after {
                    a.open = true;
                    if !a.opens_behind {
                        newly_open = Some(i);
                    }
                }
            }
        }
        if let Some(i) = newly_open {
            s.front = Some(i);
        }
        let mut out = Vec::new();
        // Front window first, like z-order.
        let mut order: Vec<usize> = (0..s.apps.len()).collect();
        if let Some(f) = s.front {
            order.retain(|&i| i != f);
            order.insert(0, f);
        }
        for i in order {
            let a = &s.apps[i];
            if !a.open {
                continue;
            }
            let fg = s.front == Some(i) && !a.minimized;
            let base = WindowRef {
                id: win_id(i, false),
                pid: 1000 + i as u32,
                title: a.title.clone(),
                app: a.app.into(),
                exe: a.exe.into(),
                minimized: a.minimized,
                foreground: fg && a.dialog.is_none(),
                started: 1,
            };
            if let Some((t, _)) = &a.dialog {
                out.push(WindowRef {
                    id: win_id(i, true),
                    title: t.clone(),
                    foreground: fg,
                    minimized: false,
                    ..base.clone()
                });
            }
            out.push(base);
        }
        out
    }

    fn responsive(&self, _: &WindowRef) -> bool {
        true
    }

    fn focus(&self, w: &WindowRef) -> HandsResult<WindowRef> {
        {
            let mut s = self.state.lock().unwrap();
            let (i, _) = Self::index_of(&s, w)?;
            s.apps[i].minimized = false;
            s.front = Some(i);
            let app = s.apps[i].app;
            s.log.push(format!("focus {app}"));
            Self::count_action(&mut s);
        }
        self.windows().into_iter().find(|x| x.id == w.id).ok_or_else(|| "the window vanished".into())
    }

    fn read(&self, w: &WindowRef) -> HandsResult<Vec<UiElement>> {
        let mut s = self.state.lock().unwrap();
        let (i, dialog) = Self::index_of(&s, w)?;
        if s.apps[i].empty_reads > 0 {
            s.apps[i].empty_reads -= 1;
            return Ok(vec![]);
        }
        let a = &s.apps[i];
        let focused_front = s.front == Some(i);
        Ok(Self::visible_elements(a, dialog)
            .into_iter()
            .enumerate()
            .map(|(n, (key, e))| UiElement {
                key,
                role: e.role.into(),
                name: e.name.clone(),
                value: e.value.clone(),
                enabled: true,
                focused: focused_front && e.editable && n == 0,
                password: e.password,
                offscreen: false,
                rect: (10, 10 + n as i32 * 30, 200, 24),
                actionable: e.role != "text",
            })
            .collect())
    }

    fn click(&self, w: &WindowRef, el: &UiElement) -> HandsResult<String> {
        let mut s = self.state.lock().unwrap();
        let (i, dialog) = Self::index_of(&s, w)?;
        Self::count_action(&mut s);
        if !dialog && s.apps[i].dialog.is_some() {
            return Err(format!(
                "nothing happened: the dialog \u{201c}{}\u{201d} is in the way",
                s.apps[i].dialog.as_ref().unwrap().0
            ));
        }
        let visible: Vec<u64> = Self::visible_elements(&s.apps[i], dialog).into_iter().map(|(k, _)| k).collect();
        if !visible.contains(&el.key) {
            return Err("that element isn't there any more (the screen changed); read_ui again".into());
        }
        let effect = Self::element_mut(&mut s.apps[i], el.key).map(|e| e.effect.clone()).unwrap_or(Effect::None);
        let app = s.apps[i].app;
        s.log.push(format!("click {app} {}", el.name));
        Self::apply(&mut s, i, effect);
        Ok("invoke".into())
    }

    fn set_text(&self, w: &WindowRef, el: &UiElement, text: &str, replace: bool) -> HandsResult<String> {
        let mut s = self.state.lock().unwrap();
        let (i, _) = Self::index_of(&s, w)?;
        Self::count_action(&mut s);
        if s.front != Some(i) {
            return Err("the window isn't in front".into());
        }
        if let Some(d) = s.apps[i].dialog_on_type.take() {
            let t = d.0.clone();
            s.apps[i].dialog = Some(d);
            return Err(format!("a dialog popped up: \u{201c}{t}\u{201d}"));
        }
        if let Some((t, _)) = &s.apps[i].dialog {
            return Err(format!("the dialog \u{201c}{t}\u{201d} is in the way"));
        }
        let a = &mut s.apps[i];
        let e = Self::element_mut(a, el.key).ok_or("that element isn't there any more")?;
        if !e.editable {
            return Err("that element doesn't take text".into());
        }
        let old = e.value.clone().unwrap_or_default();
        e.value = Some(if replace { text.to_string() } else { format!("{old}{text}") });
        if !a.title.starts_with('*') && a.exe == "notepad" {
            a.title = format!("*{}", a.title);
        }
        let app = a.app;
        s.log.push(format!("type {app} {text}"));
        Ok("value".into())
    }

    fn press(&self, w: Option<&WindowRef>, key: Key) -> HandsResult<()> {
        let mut s = self.state.lock().unwrap();
        Self::count_action(&mut s);
        if let Some(w) = w {
            let (i, _) = Self::index_of(&s, w)?;
            if key == Key::Escape {
                s.apps[i].dialog = None;
            }
            let app = s.apps[i].app;
            s.log.push(format!("press {app} {}", key.label()));
        } else {
            s.log.push(format!("press {}", key.label()));
            if key == Key::PlayPause {
                if let Some((m, _)) = &mut s.playing {
                    m.playing = !m.playing;
                }
            }
        }
        Ok(())
    }

    fn scroll(&self, w: &WindowRef, _: Option<&UiElement>, down: bool) -> HandsResult<String> {
        let mut s = self.state.lock().unwrap();
        let (i, _) = Self::index_of(&s, w)?;
        Self::count_action(&mut s);
        s.apps[i].scrolled = down;
        let app = s.apps[i].app;
        s.log.push(format!("scroll {app}"));
        Ok("scroll pattern".into())
    }

    fn media(&self, m: Media) -> HandsResult<()> {
        let mut s = self.state.lock().unwrap();
        s.log.push(format!("media {m:?}"));
        match (&mut s.playing, m) {
            (Some((st, _)), Media::Play) => st.playing = true,
            (Some((st, _)), Media::Pause) => st.playing = false,
            (Some((st, _)), Media::PlayPause) => st.playing = !st.playing,
            (Some((st, _)), Media::Next | Media::Previous) => st.title = "Another song".into(),
            (None, _) => return Err("nothing is playing or paused right now".into()),
        }
        Ok(())
    }

    fn media_status(&self) -> Option<MediaStatus> {
        self.state.lock().unwrap().playing.as_ref().map(|(m, _)| m.clone())
    }

    fn open_link(&self, uri: &str) -> HandsResult<()> {
        self.state.lock().unwrap().log.push(format!("link {uri}"));
        if uri.starts_with("spotify:") {
            self.launch("Spotify");
        }
        Ok(())
    }

    fn drive(&self, app: Option<&str>) {
        let mut s = self.state.lock().unwrap();
        s.driving = app.map(String::from);
        s.drive_log.push(app.map(String::from));
        if app.is_none() {
            s.interrupted = false;
        }
    }

    fn interrupted(&self) -> bool {
        self.state.lock().unwrap().interrupted
    }

    fn sleep(&self, _: Duration) {}
}

// ------------------------------------------------------------ scenarios

fn sidebar(scroll_needed: bool) -> Vec<MockEl> {
    let mut v = vec![
        el("button", "Home").on_click(Effect::Goto("home")),
        el("edit", "What do you want to play?"),
        el("text", "Your Library"),
        el("button", "Create playlist or folder"),
        el("list item", "Late Night Drive, Playlist \u{2022} Andor").on_click(Effect::Goto("late")),
        el("list item", "Gym Mix, Playlist \u{2022} Andor").on_click(Effect::Goto("gym")),
        el("list item", "Lo-fi Beats, Playlist \u{2022} Lofi Girl").on_click(Effect::Goto("lofi")),
        el("list item", "Daily Mix 1, Playlist \u{2022} Spotify"),
    ];
    let classical =
        el("list item", "Classical Essentials, Playlist \u{2022} Andor").on_click(Effect::Goto("classical"));
    v.push(if scroll_needed { classical.below_fold() } else { classical });
    v
}

fn player_bar() -> Vec<MockEl> {
    vec![
        el("button", "Play").on_click(Effect::Play { title: "Episode 12", artist: "Some Podcast", context: "podcast" }),
        el("button", "Next"),
        el("button", "Previous"),
        el("text", "Nothing playing"),
    ]
}

fn playlist_page(name: &'static str, songs: &[(&'static str, &'static str)], scroll_needed: bool) -> Vec<MockEl> {
    let mut v = sidebar(scroll_needed);
    v.push(el("text", name));
    let (t, a) = songs[0];
    v.push(el("button", &format!("Play {name}")).on_click(Effect::Play { title: t, artist: a, context: name }));
    v.push(el("button", "Shuffle"));
    for (t, a) in songs {
        v.push(el("row", &format!("{t}, {a}")).on_click(Effect::Play { title: t, artist: a, context: name }));
    }
    v.extend(player_bar());
    v
}

/// A Spotify-like app: slow to open, its accessibility tree empty on the
/// first read (Chromium), a library list of playlists, playlist pages with
/// "Play <name>" buttons.
pub fn spotify(scroll_needed: bool) -> MockApp {
    let mut home = sidebar(scroll_needed);
    home.extend([el("text", "Good evening"), el("button", "Show all")]);
    home.extend(player_bar());
    let mut a = MockApp::new(
        "Spotify",
        "spotify",
        "Spotify Premium",
        vec![
            ("home", home),
            (
                "late",
                playlist_page(
                    "Late Night Drive",
                    &[("Nightcall", "Kavinsky"), ("Midnight City", "M83")],
                    scroll_needed,
                ),
            ),
            ("gym", playlist_page("Gym Mix", &[("Stronger", "Kanye West")], scroll_needed)),
            ("lofi", playlist_page("Lo-fi Beats", &[("Snowman", "WYS")], scroll_needed)),
            (
                "classical",
                playlist_page(
                    "Classical Essentials",
                    &[("Clair de Lune", "Claude Debussy"), ("Moonlight Sonata", "Ludwig van Beethoven")],
                    scroll_needed,
                ),
            ),
        ],
    );
    a.appear_after = 5;
    a.empty_reads = 1;
    a.title_shows_playing = true;
    a
}

/// A Notepad-like editor with one document.
pub fn notepad() -> MockApp {
    MockApp::new(
        "Notepad",
        "notepad",
        "Untitled - Notepad",
        vec![(
            "main",
            vec![
                el("menu item", "File"),
                el("menu item", "Edit"),
                el("menu item", "View"),
                el("document", "Text editor"),
            ],
        )],
    )
}

/// Some other app in front (for "the window is behind others").
pub fn browser() -> MockApp {
    MockApp::new(
        "Google Chrome",
        "chrome",
        "News - Google Chrome",
        vec![("main", vec![el("edit", "Address and search bar"), el("link", "Top stories")])],
    )
    .already_open()
}

/// The dialog Notepad shows the first time Glitch types (scenario "dialog").
pub fn update_dialog() -> (String, Vec<MockEl>) {
    (
        "Notepad update".into(),
        vec![
            el("text", "A new version of Notepad is available."),
            el("button", "Not now").on_click(Effect::Dismiss),
            el("button", "Update").on_click(Effect::Dismiss),
        ],
    )
}
