//! Glitch core: everything that does not need a window.
//!
//! The Tauri app (`src-tauri`) is a thin shell around this crate, so all the
//! logic that matters for safety and correctness can be unit-tested headlessly.

pub mod agent;
pub mod ai;
pub mod belly;
pub mod autoupdate;
pub mod chaos;
pub mod confirm;
pub mod context;
pub mod desktop;
pub mod hands;
pub mod memory;
pub mod models;
pub mod platform;
pub mod play;
pub mod settings;
pub mod stream;
pub mod tools;
pub mod update_me;
pub mod vision;
pub mod voice;
pub mod world;
