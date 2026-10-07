// No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod layout;
mod os;
mod state;
mod windows;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let chat = MenuItem::with_id(app, "chat", "Chat with Glitch", true, None::<&str>)?;
    let wander = CheckMenuItem::with_id(
        app,
        "wander",
        "Let Glitch wander",
        true,
        state.settings().movement_enabled,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Glitch", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&chat, &wander, &sep, &quit])?;
    *state.wander_item.lock().unwrap() = Some(wander);

    let mut tray =
        TrayIconBuilder::with_id("glitch").tooltip("Glitch").menu(&menu).show_menu_on_left_click(true).on_menu_event(
            |app, event| match event.id().as_ref() {
                "chat" => windows::show_panel(app),
                "wander" => {
                    let s = app.state::<AppState>().update_settings(|s| s.movement_enabled = !s.movement_enabled);
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
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| windows::show_panel(app)))
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            app.manage(AppState::new(settings_path));
            os::configure(app);
            build_tray(app.handle())?;
            // The mascot page shows itself once drawn, and opens the setup
            // wizard on first run (so the panel can be placed next to it).
            windows::place_mascot(app.handle());
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
            commands::get_settings,
            commands::update_settings,
            commands::toggle_panel,
            commands::show_panel,
            commands::hide_panel,
            commands::quit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Glitch");
}
