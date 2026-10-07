//! Pick a model that fits this machine's RAM.
//!
//! Model names come from the Ollama library pages for models tagged "tools"
//! (checked October 2026): `qwen3.5` (0.8b/2b/4b/9b, tools + thinking),
//! `qwen3` (0.6b–8b, tools + thinking) and `llama3.2` (1b/3b, tools).
//! Download sizes are approximate; the wizard shows real progress anyway.
//!
//! To change the defaults, edit [`TIERS`] — nothing else hard-codes a model.

use serde::Serialize;

const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ModelChoice {
    /// Exact Ollama tag, e.g. "qwen3.5:2b".
    pub name: &'static str,
    /// Approximate download size in GB, shown to the user before downloading.
    pub download_gb: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Recommendation {
    pub tier: &'static str,
    pub total_ram_gb: f32,
    pub primary: ModelChoice,
    pub alternatives: Vec<ModelChoice>,
    /// Friendly warning, e.g. for very low-memory machines.
    pub note: Option<&'static str>,
}

struct Tier {
    /// Applies when total RAM is *below* this many GiB (`None` = no upper limit).
    below_gib: Option<u64>,
    /// RAM of a typical machine in this tier (used to sanity-check sizes in tests).
    #[cfg_attr(not(test), allow(dead_code))]
    typical_gib: u64,
    name: &'static str,
    primary: ModelChoice,
    alternatives: &'static [ModelChoice],
    note: Option<&'static str>,
}

/// Tiers use GiB thresholds that sit between common RAM sizes, because the OS
/// reports a bit less than the sticker size (an "8 GB" PC shows ~7.6 GiB).
/// Rule of thumb: the model's download size stays at or below about a third of
/// a typical machine's RAM in that tier, so the user's browser, games, etc.
/// keep running smoothly while Glitch is thinking.
const TIERS: &[Tier] = &[
    Tier {
        below_gib: Some(6),
        typical_gib: 4,
        name: "low (under 6 GB)",
        primary: ModelChoice { name: "qwen3.5:0.8b", download_gb: 1.0 },
        alternatives: &[ModelChoice { name: "qwen3:0.6b", download_gb: 0.5 }],
        note: Some("This computer doesn't have much memory, so Glitch will use a tiny model. It works, but its answers will be simple."),
    },
    Tier {
        below_gib: Some(12),
        typical_gib: 8,
        name: "8 GB class",
        primary: ModelChoice { name: "qwen3.5:2b", download_gb: 2.7 },
        alternatives: &[
            ModelChoice { name: "qwen3:1.7b", download_gb: 1.4 },
            ModelChoice { name: "llama3.2:3b", download_gb: 2.0 },
            ModelChoice { name: "qwen3.5:0.8b", download_gb: 1.0 },
        ],
        note: None,
    },
    Tier {
        below_gib: Some(24),
        typical_gib: 16,
        name: "16 GB class",
        primary: ModelChoice { name: "qwen3.5:4b", download_gb: 3.4 },
        alternatives: &[
            ModelChoice { name: "qwen3:4b", download_gb: 2.5 },
            ModelChoice { name: "llama3.2:3b", download_gb: 2.0 },
            ModelChoice { name: "qwen3.5:2b", download_gb: 2.7 },
        ],
        note: None,
    },
    Tier {
        below_gib: None,
        typical_gib: 32,
        name: "24 GB or more",
        primary: ModelChoice { name: "qwen3.5:9b", download_gb: 6.6 },
        alternatives: &[
            ModelChoice { name: "qwen3:8b", download_gb: 5.2 },
            ModelChoice { name: "qwen3.5:4b", download_gb: 3.4 },
        ],
        note: None,
    },
];

pub fn recommend(total_ram_bytes: u64) -> Recommendation {
    let tier = TIERS
        .iter()
        .find(|t| t.below_gib.is_none_or(|limit| total_ram_bytes < limit * GIB))
        .expect("last tier has no upper limit");
    Recommendation {
        tier: tier.name,
        total_ram_gb: (total_ram_bytes as f64 / GIB as f64 * 10.0).round() as f32 / 10.0,
        primary: tier.primary,
        alternatives: tier.alternatives.to_vec(),
        note: tier.note,
    }
}

/// Every model name Glitch might recommend (used to sort the model picker).
pub fn all_known_models() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = Vec::new();
    for t in TIERS {
        for m in std::iter::once(&t.primary).chain(t.alternatives) {
            if !v.contains(&m.name) {
                v.push(m.name);
            }
        }
    }
    v
}

/// Total physical RAM of this machine, in bytes.
pub fn total_ram_bytes() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.total_memory()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gib(x: f64) -> u64 {
        (x * GIB as f64) as u64
    }

    #[test]
    fn tiny_machines_get_the_tiny_model() {
        let r = recommend(gib(3.8)); // "4 GB" PC
        assert_eq!(r.primary.name, "qwen3.5:0.8b");
        assert!(r.note.is_some());
    }

    #[test]
    fn eight_gb_machines_as_reported_by_the_os() {
        for reported in [7.6, 7.9, 8.0, 11.9] {
            assert_eq!(recommend(gib(reported)).primary.name, "qwen3.5:2b", "{reported} GiB");
        }
    }

    #[test]
    fn sixteen_gb_machines() {
        for reported in [12.0, 15.4, 16.0, 23.9] {
            assert_eq!(recommend(gib(reported)).primary.name, "qwen3.5:4b", "{reported} GiB");
        }
    }

    #[test]
    fn big_machines_still_get_a_small_model() {
        for reported in [24.0, 31.8, 64.0, 512.0] {
            let r = recommend(gib(reported));
            assert_eq!(r.primary.name, "qwen3.5:9b");
            assert!(r.primary.download_gb < 8.0, "never recommend a big model");
        }
    }

    #[test]
    fn zero_ram_reading_is_handled() {
        // sysinfo can return 0 in sandboxes; fall back to the smallest tier.
        assert_eq!(recommend(0).primary.name, "qwen3.5:0.8b");
    }

    #[test]
    fn primary_model_is_about_a_third_of_typical_ram_or_less() {
        for t in TIERS {
            let share = t.primary.download_gb as f64 / t.typical_gib as f64;
            assert!(share <= 0.35, "{} is too big for a {} GiB machine", t.primary.name, t.typical_gib);
        }
    }

    #[test]
    fn ram_gb_is_rounded_for_display() {
        assert_eq!(recommend(gib(15.43)).total_ram_gb, 15.4);
    }

    #[test]
    fn known_models_are_unique() {
        let all = all_known_models();
        let mut dedup = all.clone();
        dedup.dedup();
        assert_eq!(all.len(), dedup.len());
        assert!(all.contains(&"llama3.2:3b"));
    }
}
