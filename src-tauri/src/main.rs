// No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod chaos;
mod chaos_native;
mod commands;
mod desktop;
mod hover;
mod layout;
mod ledge_watch;
mod os;
mod state;
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
    let quit = MenuItem::with_id(app, "quit", "Quit Glitch", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&chat, &wander, &chaos, &settings, &sep, &quit])?;
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
    tauri::Builder::default()
        // A second launch just opens the chat of the running Glitch.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { commands::open_chat(&app, false) });
        }))
        // Voice push-to-talk hotkey (registered by voice::setup, not here).
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            app.manage(AppState::new(app.handle(), app.path().app_config_dir()?));
            app.manage(hover::Hitbox::default());
            app.manage(chaos::ChaosState::default());
            voice::setup(app.handle());
            hover::start(app.handle().clone());
            os::configure(app);
            build_tray(app.handle())?;
            // The mascot page shows itself once drawn, and opens the setup
            // wizard on first run (so the panel can be placed next to it).
            // Dragging Glitch keeps the chat bubble attached (see place_mascot).
            windows::place_mascot(app.handle());
            chaos::debug_trigger(app.handle());
            Ok(())
        })
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building Glitch")
        .run(|app, event| {
            // Any way of exiting (tray Quit, OS logout, last window closed):
            // save the chat/memory. (Quit from the UI also unloads the model.)
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Ok(mut agent) = app.state::<AppState>().agent.try_lock() {
                    agent.persist();
                }
            }
        });
}
