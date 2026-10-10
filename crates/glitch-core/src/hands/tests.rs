use std::sync::Arc;

use serde_json::{json, Value};

use super::mock::{self, MockHands};
use super::*;

fn call(name: &str, args: Value) -> ToolCall {
    ToolCall { name: name.into(), arguments: args }
}

fn driver(apps: Vec<mock::MockApp>) -> (Driver, Arc<MockHands>) {
    let m = Arc::new(MockHands::new(apps));
    let d = Driver::new(m.clone());
    d.new_task("open spotify and play my first playlist");
    (d, m)
}

/// Prepare + execute, granting whatever is asked (like a user clicking Allow).
fn run(d: &Driver, name: &str, args: Value) -> Value {
    let c = call(name, args);
    match d.prepare(&c) {
        Err(v) => v,
        Ok(p) => {
            if let Ask::Grant(app) = &p.ask {
                d.grant(app);
            }
            d.execute(&p.action, &retry_key(&c)).for_model
        }
    }
}

/// The id of the first element line containing `needle`.
fn id_of(v: &Value, needle: &str) -> u64 {
    let lists =
        [&v["elements"], &v["verify"]["now_visible"], &v["dialog"]["elements"], &v["verify"]["dialog"]["elements"]];
    let line = lists
        .iter()
        .filter_map(|l| l.as_array())
        .flatten()
        .filter_map(Value::as_str)
        .find(|l| l.contains(needle))
        .unwrap_or_else(|| panic!("{needle} in {v}"));
    line[1..line.find(']').unwrap()].parse().unwrap()
}

#[test]
fn keys_parse_from_a_whitelist_only() {
    assert_eq!(Key::parse("Enter"), Some(Key::Enter));
    assert_eq!(Key::parse("Ctrl+L"), Some(Key::CtrlL));
    assert_eq!(Key::parse("control-f"), Some(Key::CtrlF));
    assert_eq!(Key::parse("ArrowDown"), Some(Key::Down));
    assert_eq!(Key::parse("play_pause"), Some(Key::PlayPause));
    for bad in ["alt+f4", "win", "ctrl+a", "delete", "ctrl+w", "f5"] {
        assert_eq!(Key::parse(bad), None, "{bad}");
    }
    for (i, n) in Key::NAMES.iter().enumerate() {
        assert_eq!(Key::parse(n).unwrap() as usize, i, "{n}");
        assert_eq!(Key::parse(n).unwrap().label(), *n);
    }
}

#[test]
fn spotify_flow_slow_start_empty_tree_then_plays_the_first_playlist() {
    let (d, m) = driver(vec![mock::browser(), mock::spotify(false)]);
    m.launch("Spotify");
    let w = run(&d, WAIT_FOR_WINDOW, json!({"target": "spotify"}));
    assert_eq!(w["ready"], true, "{w}");
    let r = run(&d, READ_UI, json!({"target": "Spotify", "query": "playlist"}));
    let first = r["elements"].as_array().unwrap().iter().filter_map(Value::as_str).find(|l| l.contains("list item"));
    assert!(first.unwrap().contains("Late Night Drive"), "first list item: {r}");
    let c = run(&d, UI_CLICK, json!({"id": id_of(&r, "Late Night Drive")}));
    assert_eq!(c["verify"]["changed"], true, "{c}");
    let play = run(&d, UI_CLICK, json!({"id": id_of(&c, "Play Late Night Drive")}));
    assert!(play["verify"]["media"].as_str().unwrap().contains("playing Nightcall"), "{play}");
    assert_eq!(m.playing(), Some(("Nightcall".into(), "Late Night Drive".into())));
    // The banner went up for the first control action.
    assert_eq!(m.state.lock().unwrap().drive_log, [Some("Spotify".to_string())]);
    d.stop();
    assert_eq!(m.state.lock().unwrap().drive_log.last(), Some(&None));
}

#[test]
fn first_control_action_asks_for_the_app_then_not_again() {
    let (d, _m) = driver(vec![mock::spotify(false).already_open()]);
    let r = run(&d, READ_UI, json!({"target": "spotify"}));
    let r = if r["elements"].as_array().is_none_or(|a| a.is_empty()) {
        run(&d, READ_UI, json!({"target": "spotify"}))
    } else {
        r
    };
    let id = id_of(&r, "Gym Mix");
    let p = d.prepare(&call(UI_CLICK, json!({"id": id}))).unwrap();
    assert_eq!(p.ask, Ask::Grant("Spotify".into()));
    d.grant("Spotify");
    let p = d.prepare(&call(UI_CLICK, json!({"id": id}))).unwrap();
    assert_eq!(p.ask, Ask::No);
    // Reading never asks.
    assert_eq!(d.prepare(&call(READ_UI, json!({"target": "spotify"}))).unwrap().ask, Ask::No);
    // A new task forgets the grant.
    d.new_task("something else");
    assert!(!d.granted("spotify"));
}

#[test]
fn minimized_window_must_be_restored_and_unknown_ids_are_explained() {
    let mut sp = mock::spotify(false).already_open();
    sp.minimized = true;
    sp.empty_reads = 0;
    let (d, _m) = driver(vec![mock::browser(), sp]);
    let r = run(&d, READ_UI, json!({"target": "Spotify"}));
    assert_eq!(r["ok"], false);
    assert!(r["try_next"][0].as_str().unwrap().contains("focus_window"), "{r}");
    let f = run(&d, FOCUS_WINDOW, json!({"target": "Spotify"}));
    assert_eq!(f["in_front"], true, "{f}");
    assert_eq!(run(&d, READ_UI, json!({"target": "Spotify"}))["ok"], true);
    let bad = run(&d, UI_CLICK, json!({"id": 999}));
    assert!(bad["error"].as_str().unwrap().contains("no element [999]"));
}

#[test]
fn hidden_list_items_appear_after_scrolling() {
    let mut sp = mock::spotify(true).already_open();
    sp.empty_reads = 0;
    let (d, _m) = driver(vec![sp]);
    let r = run(&d, READ_UI, json!({"target": "Spotify", "query": "Classical"}));
    assert!(r["note"].as_str().unwrap().contains("ui_scroll"), "{r}");
    let s = run(&d, UI_SCROLL, json!({"target": "Spotify"}));
    assert_eq!(s["verify"]["changed"], true);
    let r = run(&d, READ_UI, json!({"target": "Spotify", "query": "Classical"}));
    assert!(r["elements"][0].as_str().unwrap().contains("Classical Essentials"), "{r}");
}

#[test]
fn a_dialog_that_pops_up_is_reported_and_can_be_dismissed() {
    let mut np = mock::notepad().already_open();
    np.dialog_on_type = Some(mock::update_dialog());
    let (d, m) = driver(vec![np]);
    d.new_task("open notepad and type hello");
    let r = run(&d, READ_UI, json!({"target": "notepad", "query": "text editor"}));
    let doc = id_of(&r, "Text editor");
    let t = run(&d, UI_SET_TEXT, json!({"id": doc, "text": "hello"}));
    assert_eq!(t["ok"], false);
    assert_eq!(t["attempt"], 1);
    // Reading the app now shows the dialog in front.
    let r = run(&d, READ_UI, json!({"target": "notepad"}));
    assert_eq!(r["window"], "Notepad update", "{r}");
    run(&d, UI_CLICK, json!({"id": id_of(&r, "Not now")}));
    let t = run(&d, UI_SET_TEXT, json!({"id": doc, "text": "hello"}));
    assert_eq!(t["ok"], true, "{t}");
    assert_eq!(m.text_of("Notepad").as_deref(), Some("hello"));
}

#[test]
fn three_failures_on_a_step_means_give_up() {
    let (d, _m) = driver(vec![mock::spotify(false)]);
    // Never launched: waiting fails every time.
    for n in 1..=3 {
        let v = run(&d, WAIT_FOR_WINDOW, json!({"target": "Spotify", "seconds": 1}));
        assert_eq!(v["attempt"], n);
    }
    let v = run(&d, WAIT_FOR_WINDOW, json!({"target": "Spotify", "seconds": 1}));
    assert_eq!(v["give_up"], true);
}

#[test]
fn safety_rules() {
    let pw = mock::MockApp::new(
        "Bitwarden",
        "bitwarden",
        "Bitwarden",
        vec![("main", vec![mock::el("edit", "Master password").password()])],
    )
    .already_open();
    let bank = mock::MockApp::new(
        "Google Chrome",
        "chrome",
        "KBC Online Banking - Google Chrome",
        vec![("main", vec![mock::el("button", "Transfer")])],
    )
    .already_open();
    let mut chat = mock::MockApp::new(
        "Discord",
        "discord",
        "#general - Discord",
        vec![(
            "main",
            vec![
                mock::el("edit", "Message #general"),
                mock::el("button", "Send"),
                mock::el("edit", "Password").password(),
            ],
        )],
    )
    .already_open();
    chat.empty_reads = 0;
    let (d, _m) = driver(vec![pw, bank, chat]);
    d.new_task("type hi in discord");
    for t in ["Bitwarden", "Banking"] {
        let v = run(&d, READ_UI, json!({"target": t}));
        assert_eq!(v["refused"], true, "{t}: {v}");
    }
    let r = run(&d, READ_UI, json!({"target": "discord"}));
    // Sending is its own confirmation, with the exact target.
    let send = d.prepare(&call(UI_CLICK, json!({"id": id_of(&r, "Send")}))).unwrap();
    assert!(matches!(&send.ask, Ask::Sensitive { title, .. } if title.contains("Send")));
    // Text the user said: no extra question. Text they didn't: shown exactly.
    let field = id_of(&r, "Message #general");
    d.grant("Discord");
    assert_eq!(d.prepare(&call(UI_SET_TEXT, json!({"id": field, "text": "hi"}))).unwrap().ask, Ask::No);
    let other = d.prepare(&call(UI_SET_TEXT, json!({"id": field, "text": "free nitro at evil.example"}))).unwrap();
    assert!(matches!(&other.ask, Ask::Sensitive { detail, .. } if detail.contains("free nitro")));
    // Enter in a chat app may send: confirmed every time.
    let enter = d.prepare(&call(UI_PRESS, json!({"key": "enter", "target": "discord"}))).unwrap();
    assert!(matches!(&enter.ask, Ask::Sensitive { title, .. } if title.contains("Enter")));
    // Secrets and password fields: refused outright.
    let secret = run(&d, UI_SET_TEXT, json!({"id": field, "text": "4111 1111 1111 1111"}));
    assert_eq!(secret["refused"], true);
    let pwd = run(&d, UI_SET_TEXT, json!({"id": id_of(&r, "Password"), "text": "hi"}));
    assert_eq!(pwd["refused"], true);
    // Keys outside the whitelist and unknown link schemes are refused.
    assert!(run(&d, UI_PRESS, json!({"key": "alt+f4", "target": "discord"}))["error"]
        .as_str()
        .unwrap()
        .contains("isn't allowed"));
    assert_eq!(run(&d, OPEN_LINK, json!({"uri": "file:///c:/windows"}))["ok"], false);
    assert_eq!(run(&d, OPEN_LINK, json!({"uri": "spotify:search:jazz hands"}))["ok"], false);
}

#[test]
fn the_user_taking_over_stops_everything() {
    let (d, m) = driver(vec![mock::notepad().already_open()]);
    m.state.lock().unwrap().interrupt_after = Some(1);
    d.grant("Notepad");
    let r = run(&d, READ_UI, json!({"target": "notepad"}));
    let doc = id_of(&r, "Text editor");
    run(&d, FOCUS_WINDOW, json!({"target": "notepad"}));
    assert!(d.interrupted());
    let v = run(&d, UI_SET_TEXT, json!({"id": doc, "text": "hello"}));
    assert_eq!(v["stopped"], true);
    assert_eq!(m.text_of("Notepad"), None);
}

#[test]
fn media_needs_no_window_and_reports_what_plays() {
    let (d, m) = driver(vec![mock::spotify(false).already_open()]);
    assert_eq!(d.prepare(&call(MEDIA_CONTROL, json!({"action": "pause"}))).unwrap().ask, Ask::No);
    assert_eq!(run(&d, MEDIA_CONTROL, json!({"action": "pause"}))["ok"], false, "nothing playing yet");
    m.state.lock().unwrap().playing = Some((
        MediaStatus { app: "Spotify".into(), title: "Nightcall".into(), artist: "Kavinsky".into(), playing: false },
        "x",
    ));
    let v = run(&d, MEDIA_CONTROL, json!({"action": "play"}));
    assert_eq!(v["media"], "playing Nightcall by Kavinsky in Spotify");
}

#[test]
fn task_triggers() {
    let none: Vec<String> = vec![];
    assert!(task_trigger("open spotify and play my first playlist", &none));
    assert!(task_trigger("open notepad and type hello", &none));
    assert!(task_trigger("play some jazz on spotify", &none));
    assert!(task_trigger("type hello in notepad", &none));
    assert!(!task_trigger("open spotify", &none));
    assert!(!task_trigger("what's 15% of 80?", &none));
    assert!(!task_trigger("write down that the dentist is on Friday", &none));
    assert!(task_trigger("click the save button in Figma", &["Figma".to_string()]));
}

#[test]
fn specs_are_well_formed() {
    let s = specs();
    assert_eq!(s.len(), TOOL_NAMES.len());
    for (t, n) in s.iter().zip(TOOL_NAMES) {
        assert_eq!(t.name, *n);
        assert_eq!(t.parameters["type"], "object");
    }
}

#[test]
fn the_target_is_checked_again_right_before_acting() {
    let (d, m) = driver(vec![mock::notepad().already_open()]);
    d.new_task("type hello in notepad");
    d.grant("Notepad");
    let r = run(&d, READ_UI, json!({"target": "notepad"}));
    let doc = id_of(&r, "Text editor");
    let p = d.prepare(&call(UI_SET_TEXT, json!({"id": doc, "text": "hello"}))).unwrap();
    // Between approval and acting, the element turns into a password box.
    m.state.lock().unwrap().apps[0].screens[0].1[3].password = true;
    let v = d.execute(&p.action, "k").for_model;
    assert_eq!(v["refused"], true, "{v}");
    // ...or the window goes away.
    m.state.lock().unwrap().apps[0].screens[0].1[3].password = false;
    let p = d.prepare(&call(UI_SET_TEXT, json!({"id": doc, "text": "hello"}))).unwrap();
    m.state.lock().unwrap().apps[0].open = false;
    let v = d.execute(&p.action, "k").for_model;
    assert!(v["error"].as_str().unwrap().contains("closed"), "{v}");
    assert_eq!(m.text_of("Notepad"), None, "nothing was typed");
}

#[test]
fn secrets_split_over_calls_and_address_bars_are_refused() {
    let (d, _m) = driver(vec![mock::browser(), mock::notepad().already_open()]);
    d.new_task("type 4111 1111 then 1111 1111 in notepad, and type example.com in chrome");
    d.grant("Notepad");
    d.grant("Google Chrome");
    let r = run(&d, READ_UI, json!({"target": "notepad"}));
    let doc = id_of(&r, "Text editor");
    assert_eq!(run(&d, UI_SET_TEXT, json!({"id": doc, "text": "4111 1111 1111"}))["ok"], true);
    let v = run(&d, UI_SET_TEXT, json!({"id": doc, "text": "1111"}));
    assert_eq!(v["refused"], true, "{v}");
    let r = run(&d, READ_UI, json!({"target": "chrome"}));
    let v = run(&d, UI_SET_TEXT, json!({"id": id_of(&r, "Address and search bar"), "text": "example.com"}));
    assert!(v["error"].as_str().unwrap().contains("open_url"), "{v}");
    assert_eq!(run(&d, UI_PRESS, json!({"key": "ctrl+l", "target": "chrome"}))["refused"], true);
}

#[test]
fn searching_finds_hidden_playlists_too() {
    let mut sp = mock::spotify(true).already_open();
    sp.empty_reads = 0;
    let (d, m) = driver(vec![sp]);
    d.grant("Spotify");
    let r = run(&d, READ_UI, json!({"target": "Spotify", "query": "search"}));
    let field = id_of(&r, "What do you want to play?");
    run(&d, UI_SET_TEXT, json!({"id": field, "text": "classical", "replace": true}));
    let v = run(&d, UI_PRESS, json!({"key": "enter", "target": "Spotify"}));
    let c = run(&d, UI_CLICK, json!({"id": id_of(&v, "Classical Essentials")}));
    run(&d, UI_CLICK, json!({"id": id_of(&c, "Play Classical Essentials")}));
    assert_eq!(m.playing().unwrap().1, "Classical Essentials");
}

// ------------------------------------------------------------ unsaved work

fn typed_text(d: &Driver, target: &str) -> Value {
    let r = run(d, READ_UI, json!({"target": target, "query": "text editor"}));
    run(d, UI_SET_TEXT, json!({"id": id_of(&r, "Text editor"), "text": "hello"}))
}

/// Click the first button of whatever is in front (a dialog, if one is up).
fn click_a_button(d: &Driver, target: &str) -> Value {
    let r = run(d, READ_UI, json!({"target": target}));
    run(d, UI_CLICK, json!({"id": id_of(&r, "button")}))
}

fn assert_refused_for_unsaved(v: &Value) {
    assert_eq!(v["refused"], true, "{v}");
    assert!(v["error"].as_str().unwrap().contains("isn't saved"), "{v}");
}

#[test]
fn dirty_titles_stop_every_acting_call_but_reading_still_works() {
    for title in [
        "*reddit-posts.md - Notepad",
        "\u{25CF} main.ts - Visual Studio Code",
        "report [modified] - Notepad",
        "Untitled - Notepad",
    ] {
        let mut np = mock::notepad().already_open();
        np.title = title.into();
        let (d, m) = driver(vec![np]);
        // Reading is harmless and allowed.
        let r = run(&d, READ_UI, json!({"target": "notepad", "query": "text editor"}));
        assert_eq!(r["ok"], true, "{title}: {r}");
        let id = id_of(&r, "Text editor");
        assert_refused_for_unsaved(&run(&d, UI_SET_TEXT, json!({"id": id, "text": "hello"})));
        assert_refused_for_unsaved(&run(&d, UI_CLICK, json!({"id": id})));
        assert_refused_for_unsaved(&run(&d, UI_SCROLL, json!({"target": "notepad"})));
        assert_refused_for_unsaved(&run(&d, UI_PRESS, json!({"target": "notepad", "key": "Enter"})));
        assert_refused_for_unsaved(&run(&d, FOCUS_WINDOW, json!({"target": "notepad"})));
        assert_eq!(m.text_of("Notepad"), None, "{title}: nothing was typed");
        assert!(m.log().iter().all(|l| !l.starts_with("type") && !l.starts_with("click")), "{:?}", m.log());
    }
}

#[test]
fn a_saved_document_is_fine() {
    let (d, m) = driver(vec![mock::notepad().already_open()]);
    let r = typed_text(&d, "notepad");
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(m.text_of("Notepad").as_deref(), Some("hello"));
}

#[test]
fn a_blank_document_glitch_opened_itself_may_be_typed_into() {
    // "open notepad and type hello": the new Untitled window is Glitch's own...
    let mut np = mock::notepad();
    np.title = "Untitled - Notepad".into();
    let (d, m) = driver(vec![np]);
    m.launch("Notepad");
    assert_eq!(run(&d, WAIT_FOR_WINDOW, json!({"target": "notepad"}))["ready"], true);
    let r = typed_text(&d, "notepad");
    assert_eq!(r["ok"], true, "{r}");
    // ...and stays usable after Notepad adds its `*`.
    m.state.lock().unwrap().apps[0].title = "*Untitled - Notepad".into();
    let again = typed_text(&d, "notepad");
    assert_eq!(again["ok"], true, "{again}");
}

#[test]
fn an_untitled_window_that_was_already_open_belongs_to_the_user() {
    let mut np = mock::notepad().already_open();
    np.title = "*Untitled - Notepad".into();
    let (d, _m) = driver(vec![np]);
    assert_refused_for_unsaved(&typed_text(&d, "notepad"));
    // A new task re-takes the baseline, the window is still the user's.
    d.new_task("type hello into notepad");
    assert_refused_for_unsaved(&typed_text(&d, "notepad"));
}

#[test]
fn a_save_prompt_in_the_window_tree_or_a_save_dialog_blocks_acting() {
    // "Do you want to save changes?" shown as a dialog of the same program.
    let mut np = mock::notepad().already_open();
    np.dialog = Some((
        "Notepad".into(),
        vec![
            mock::el("text", "Do you want to save changes to notes.txt?"),
            mock::el("button", "Save"),
            mock::el("button", "Don't save").on_click(mock::Effect::Dismiss),
        ],
    ));
    let (d, m) = driver(vec![np]);
    assert_refused_for_unsaved(&click_a_button(&d, "notepad"));
    assert!(m.log().iter().all(|l| !l.starts_with("type") && !l.starts_with("click")), "{:?}", m.log());

    // A "Save As" dialog by title.
    let mut np = mock::notepad().already_open();
    np.dialog = Some(("Save As".into(), vec![mock::el("edit", "File name"), mock::el("button", "Cancel")]));
    let (d, _m) = driver(vec![np]);
    assert_refused_for_unsaved(&click_a_button(&d, "notepad"));

    // The same prompt inside the main window's own tree.
    let mut np = mock::notepad().already_open();
    np.screens[0].1.push(mock::el("text", "You have unsaved changes"));
    let (d, _m) = driver(vec![np]);
    assert_refused_for_unsaved(&typed_text(&d, "notepad"));

    // An ordinary dialog (an update notice) does not.
    let mut np = mock::notepad().already_open();
    np.dialog = Some(mock::update_dialog());
    let (d, _m) = driver(vec![np]);
    assert_eq!(click_a_button(&d, "notepad")["ok"], true);
}

#[test]
fn a_window_that_turns_dirty_between_approval_and_action_is_not_touched() {
    let mut np = mock::notepad().already_open();
    np.title = "notes.txt - Notepad".into();
    let (d, m) = driver(vec![np]);
    let r = run(&d, READ_UI, json!({"target": "notepad", "query": "text editor"}));
    let c = call(UI_SET_TEXT, json!({"id": id_of(&r, "Text editor"), "text": "hello"}));
    let p = d.prepare(&c).unwrap();
    // The user types something in the meantime: the title gets its `*`.
    m.state.lock().unwrap().apps[0].title = "*notes.txt - Notepad".into();
    let done = d.execute(&p.action, &retry_key(&c));
    assert!(!done.ok, "{:?}", done.for_model);
    assert_eq!(done.for_model["refused"], true, "{}", done.for_model);
    assert_eq!(m.text_of("Notepad"), None);
}
