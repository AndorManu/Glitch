//! App-shell differences between operating systems. (Tool/file/app
//! differences live in `glitch-core/src/platform`.)

/// macOS: run as an "accessory" app: no Dock icon and no app menu, like a
/// menu-bar utility. Glitch is reached through its own window and the
/// menu-bar (tray) icon.
#[cfg(target_os = "macos")]
pub fn configure(app: &mut tauri::App) {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Windows: nothing to do. The mascot is hidden from the taskbar via
/// `skipTaskbar` in tauri.conf.json; the tray icon lives in the notification
/// area (it may be inside the "^" overflow until the user pins it).
#[cfg(not(target_os = "macos"))]
pub fn configure(_app: &mut tauri::App) {}
