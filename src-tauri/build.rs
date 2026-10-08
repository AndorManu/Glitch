/// Every app command (the `generate_handler!` list in src/main.rs). Listing
/// them here gives each one its own `allow-<command>` permission, and from
/// then on a window may only call the commands its capability file in
/// `capabilities/` grants (review 2026-10-08, L4). A new command must be
/// added here AND to the capability of the window that calls it; the test in
/// src/capabilities_check.rs fails otherwise.
const COMMANDS: &[&str] = &[
    "bubble_closing",
    "chaos_debug_log",
    "chaos_drag_cursor",
    "chaos_drag_window",
    "chaos_grab_cursor",
    "chaos_grab_window",
    "chaos_note_close",
    "chaos_note_move",
    "chaos_note_open",
    "chaos_note_open_now",
    "chaos_paws",
    "chaos_paws_idle",
    "chaos_release_cursor",
    "chaos_release_window",
    "chaos_status",
    "chaos_windows",
    "clear_memory",
    "confirm_action",
    "context_debug",
    "context_status",
    "cool_model",
    "finish_setup",
    "focus_start",
    "forget_memory",
    "get_memory",
    "get_settings",
    "hide_bubble",
    "hide_panel",
    "ledge_frame",
    "ledge_watch",
    "mascot_clicked",
    "open_ollama_download",
    "panel_view",
    "pull_model",
    "quit",
    "reset_chat",
    "resize_bubble",
    "send_message",
    "set_hitbox",
    "setup_status",
    "show_bubble",
    "show_panel",
    "start_ollama",
    "update_context_settings",
    "update_settings",
    "update_voice_settings",
    "voice_cancel",
    "voice_cancel_download",
    "voice_delete_model",
    "voice_download_model",
    "voice_hands_free",
    "voice_offer_seen",
    "voice_open_mic_settings",
    "voice_start",
    "voice_status",
    "voice_stop",
    "warm_model",
    "world_snapshot",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
