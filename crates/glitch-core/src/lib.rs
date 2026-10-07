//! Glitch core: everything that does not need a window.
//!
//! The Tauri app (`src-tauri`) is a thin shell around this crate, so all the
//! logic that matters for safety and correctness can be unit-tested headlessly.

pub mod ai;
pub mod models;
pub mod settings;
