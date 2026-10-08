/// Every app command (the `generate_handler!` list in src/main.rs). Listing
/// them here gives each one its own `allow-<command>` permission, and from
/// then on a window may only call the commands its capability file in
/// `capabilities/` grants (review 2026-10-08, L4). A new command must be
/// added here AND to the capability of the window that calls it; the test in
/// src/capabilities_check.rs fails otherwise.
const COMMANDS: &[&str] = &[
    "setup_status",
    "start_ollama",
    "open_ollama_download",
    "pull_model",
    "send_message",
    "confirm_action",
    "reset_chat",
    "warm_model",
    "cool_model",
    "get_settings",
    "update_settings",
    "mascot_clicked",
    "show_bubble",
    "hide_bubble",
    "bubble_closing",
    "resize_bubble",
    "show_panel",
    "panel_view",
    "hide_panel",
    "finish_setup",
    "get_memory",
    "forget_memory",
    "clear_memory",
    "world_snapshot",
    "set_hitbox",
    "quit",
    "chaos_status",
    "chaos_windows",
    "chaos_grab_window",
    "chaos_drag_window",
    "chaos_release_window",
    "chaos_grab_cursor",
    "chaos_drag_cursor",
    "chaos_release_cursor",
    "chaos_paws",
    "chaos_paws_idle",
    "chaos_note_open",
    "chaos_note_move",
    "chaos_note_close",
    "chaos_note_open_now",
    "chaos_debug_log",
    "ledge_watch",
    "ledge_frame",
    "voice_status",
    "update_voice_settings",
    "voice_start",
    "voice_stop",
    "voice_hands_free",
    "voice_cancel",
    "voice_offer_seen",
    "voice_download_model",
    "voice_cancel_download",
    "voice_delete_model",
    "voice_open_mic_settings",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
