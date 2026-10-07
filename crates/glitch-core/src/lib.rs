//! Glitch core: everything that does not need a window.
//!
//! The Tauri app (`src-tauri`) is a thin shell around this crate, so all the
//! logic that matters for safety and correctness can be unit-tested headlessly.

pub mod agent;
pub mod ai;
pub mod chaos;
pub mod confirm;
pub mod desktop;
pub mod hands;
pub mod memory;
pub mod models;
pub mod platform;
pub mod settings;
pub mod tools;
pub mod vision;
pub mod voice;
pub mod world;
