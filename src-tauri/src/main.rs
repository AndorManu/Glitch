// No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autostart;
mod autoupdate;
#[cfg(test)]
mod capabilities_check;
mod chaos;
#[cfg(test)]
mod chaos_guard;
mod chaos_native;
mod commands;
mod context;
mod context_native;
mod desktop;
mod hands;
#[cfg(all(test, target_os = "windows"))]
mod hands_live;
mod hover;
mod layout;
mod ledge_watch;
#[cfg(target_os = "windows")]
mod notify_win;
mod os;
mod pause;
mod play;
mod play_native;
mod state;
mod stream;
#[cfg(all(test, target_os = "windows"))]
mod unsaved_live;
mod update_me;
mod voice;
mod windows;
mod world_native;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let chat = MenuItem::with_id(app, "chat", "Chat with Glitch", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let wander = CheckMenuItem::with_id(
        app,
        "wander",
        "Let Glitch wander",
        true,
        state.settings().movement_enabled,
        None::<&str>,
    )?;
    let chaos = CheckMenuItem::with_id(app, "chaos", "Chaos mode", true, state.settings().chaos_enabled, None::<&str>)?;
    let focus = context::tray_item(app)?;
    let wake = voice::tray::menu_item(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Glitch", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep_top = PredefinedMenuItem::separator(app)?;
    let fetch = MenuItem::with_id(app, "play_fetch", "Play fetch", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "play_hide", "Play hide and seek", true, None::<&str>)?;
    // The panic button, first: "Hide Glitch / Pause everything" <-> "Show Glitch".
    let pause = pause::tray_items(app, chat.clone())?;
    let menu = Menu::with_items(
        app,
        &[&pause, &sep_top, &chat, &fetch, &hide, &wander, &chaos, &focus, &wake, &settings, &sep, &quit],
    )?;
    *state.wander_item.lock().unwrap() = Some(wander);
    *state.chaos_item.lock().unwrap() = Some(chaos);

    let mut tray =
        TrayIconBuilder::with_id("glitch").tooltip("Glitch").menu(&menu).show_menu_on_left_click(true).on_menu_event(
            |app, event| match event.id().as_ref() {
                // Off the event handler: creating a window there deadlocks on Windows.
                "chat" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move { commands::open_chat(&app, false) });
                }
                "settings" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move { commands::show_panel_view(&app, "settings") });
                }
                "wander" => {
                    let s = app.state::<AppState>().update_settings(|s| s.movement_enabled = !s.movement_enabled);
                    if !s.movement_enabled {
                        chaos::stop_all(app);
                    }
                    let _ = app.emit("settings-changed", &s);
                }
                "chaos" => {
                    let s = app.state::<AppState>().update_settings(|s| s.chaos_enabled = !s.chaos_enabled);
                    if !s.chaos_enabled {
                        chaos::stop_all(app);
                    }
                    let _ = app.emit("settings-changed", &s);
                }
                "pause" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        pause::toggle(&app);
                    });
                }
                "play_fetch" => play::start_game(app, glitch_core::play::Game::Fetch),
                "play_hide" => play::start_game(app, glitch_core::play::Game::HideSeek),
                "focus" => context::tray_toggle(app),
                voice::tray::MENU_ID => voice::wake::toggle(app),
                "quit" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move { commands::quit_app(&app).await });
                }
                _ => {}
            },
        );
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    let context = tauri::generate_context!();
    // `glitch --notify "build done"` / the Claude Code hook: send the event
    // to the running Glitch and exit, no windows.
    if let Some(code) = update_me::cli(&context.config().identifier) {
        std::process::exit(code);
    }
    tauri::Builder::default()
        // A second launch just opens the chat of the running Glitch.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { commands::open_chat(&app, false) });
        }))
        // Auto-update (src/autoupdate.rs). No JS permissions: commands only.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Voice push-to-talk hotkey (registered by voice::setup, not here).
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Glitch's belly: folder picker + "eat this?" (used from Rust only).
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(play::PlayState::new(&app.path().app_config_dir()?));
            app.manage(AppState::new(app.handle(), app.path().app_config_dir()?));
            pause::setup(app.handle());
            autostart::sync_on_start(app.handle());
            update_me::setup(app.handle(), app.path().app_config_dir()?);
            app.manage(hover::Hitbox::default());
            app.manage(chaos::ChaosState::default());
            app.manage(context::ContextState::default());
            voice::setup(app.handle());
            stream::setup(app.handle());
            autoupdate::setup(app.handle());
            hover::start(app.handle().clone());
            os::configure(app);
            build_tray(app.handle())?;
            // The wake word may have armed before the tray existed.
            voice::tray::show_wake(app.handle(), &voice::wake::status(app.handle()));
            // The mascot page shows itself once drawn, and opens the setup
            // wizard on first run (so the panel can be placed next to it).
            // Dragging Glitch keeps the chat bubble attached (see place_mascot).
            windows::place_mascot(app.handle());
            windows::keep_out_of_switcher(app.handle());
            pause::after_windows(app.handle());
            play::watch_drops(app.handle());
            chaos::debug_trigger(app.handle());
            context::start(app.handle());
            context::debug_trigger(app.handle());
            Ok(())
        })
        // A new command also goes into build.rs and a window's capabilities/ file.
        .invoke_handler(tauri::generate_handler![
            commands::setup_status,
            commands::start_ollama,
            commands::open_ollama_download,
            commands::pull_model,
            commands::send_message,
            commands::confirm_action,
            commands::reset_chat,
            commands::warm_model,
            commands::cool_model,
            commands::get_settings,
            commands::update_settings,
            commands::mascot_clicked,
            commands::show_bubble,
            commands::hide_bubble,
            commands::bubble_closing,
            commands::resize_bubble,
            commands::show_panel,
            commands::panel_view,
            commands::hide_panel,
            commands::finish_setup,
            commands::get_memory,
            commands::forget_memory,
            commands::clear_memory,
            commands::world_snapshot,
            commands::set_hitbox,
            commands::quit,
            chaos::chaos_status,
            chaos::chaos_windows,
            chaos::chaos_grab_window,
            chaos::chaos_drag_window,
            chaos::chaos_release_window,
            chaos::chaos_grab_cursor,
            chaos::chaos_drag_cursor,
            chaos::chaos_release_cursor,
            chaos::chaos_paws,
            chaos::chaos_paws_idle,
            chaos::chaos_note_open,
            chaos::chaos_note_move,
            chaos::chaos_note_close,
            chaos::chaos_note_open_now,
            chaos::chaos_debug_log,
            pause::safety_status,
            pause::safety_set_paused,
            pause::safety_set_hotkey,
            pause::safety_set_autostart,
            play::pet_state,
            play::pet_event,
            play::update_play_settings,
            play::ball_open,
            play::ball_frame,
            play::playfield_ready,
            play::playfield_idle,
            play::ball_hold,
            play::ball_close,
            play::growth_greeting,
            play::belly_list,
            play::belly_restore,
            play::belly_choose_folder,
            context::context_status,
            context::focus_start,
            context::update_context_settings,
            context::context_debug,
            ledge_watch::ledge_watch,
            ledge_watch::ledge_frame,
            voice::commands::voice_status,
            voice::commands::update_voice_settings,
            voice::commands::voice_start,
            voice::commands::voice_stop,
            voice::commands::voice_hands_free,
            voice::commands::voice_cancel,
            voice::commands::voice_offer_seen,
            voice::commands::voice_download_model,
            voice::commands::voice_cancel_download,
            voice::commands::voice_delete_model,
            voice::commands::voice_open_mic_settings,
            voice::commands::voice_speaking,
            voice::commands::voice_tts_prepare,
            voice::commands::voice_tts_speak,
            voice::commands::voice_tts_stop,
            voice::commands::voice_tts_download,
            voice::commands::voice_tts_cancel_download,
            voice::commands::voice_tts_delete,
            stream::stream_status,
            stream::update_stream_settings,
            stream::stream_new_token,
            stream::stream_test_event,
            stream::stream_copy,
            stream::stream_mirror,
            autoupdate::update_status,
            autoupdate::update_check,
            autoupdate::update_set_auto,
            autoupdate::update_later,
            autoupdate::update_install,
            update_me::update_me_status,
            update_me::update_me_set,
            update_me::claude_connect,
            update_me::claude_disconnect,
            update_me::reminder_delete,
            update_me::update_pending,
            update_me::update_seen,
            update_me::update_choose,
            update_me::briefing_today,
            update_me::location_search,
            update_me::update_me_test,
            update_me::update_me_fake_toast,
        ])
        .build(context)
        .expect("error while building Glitch")
        .run(|app, event| {
            // Any way of exiting (tray Quit, OS logout, last window closed):
            // save the chat/memory. (Quit from the UI also unloads the model.)
            if let tauri::RunEvent::Exit = event {
                // Close the always-on microphone and any voice playback.
                voice::wake::shutdown(app);
                voice::tts::stop(app);
            }
            if let tauri::RunEvent::ExitRequested { .. } = event {
                update_me::shutdown(app);
                if let Ok(mut agent) = app.state::<AppState>().agent.try_lock() {
                    agent.persist();
                }
            }
        });
}
