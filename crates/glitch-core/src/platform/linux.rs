//! Linux is not a supported target for Glitch yet; this exists so the project
//! builds and tests run on Linux CI machines and dev boxes.

use std::path::PathBuf;

use super::{AppEntry, OllamaInstall};

/// App discovery is not implemented on Linux (`open_app` will say so).
pub fn installed_apps() -> Vec<AppEntry> {
    Vec::new()
}

pub fn ollama_candidates(path_dirs: &[PathBuf]) -> Vec<OllamaInstall> {
    path_dirs.iter().map(|d| OllamaInstall::Cli(d.join("ollama"))).collect()
}
