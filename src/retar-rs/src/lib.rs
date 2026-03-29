use wasm_bindgen::prelude::*;
use std::collections::{HashMap, HashSet};

pub mod types;
pub mod possibilities;
pub mod combinatorics;
pub mod solver;
pub mod role_testers;
pub mod plan_builder;
pub mod finalizer;
pub mod village_retar;

use types::{SystemRole, Seat, VillageStatus, AnalyzeOptions};
use village_retar::VillageRetar;

/// WASM entry point: takes JSON strings, returns JSON string.
///
/// Input:  village_json, setup_json, options_json
/// Output: JSON object {"1": ["seer", "villager"], "2": ["werewolf"], ...}
#[wasm_bindgen]
pub fn analyze(village_json: &str, setup_json: &str, options_json: &str) -> String {
    console_error_panic_hook::set_once();

    let vs: VillageStatus = match serde_json::from_str(village_json) {
        Ok(v) => v,
        Err(e) => return format!("{{\"error\": \"village parse error: {}\"}}", e),
    };
    let setup_raw: HashMap<SystemRole, u32> = match serde_json::from_str(setup_json) {
        Ok(v) => v,
        Err(e) => return format!("{{\"error\": \"setup parse error: {}\"}}", e),
    };
    let options: AnalyzeOptions = match serde_json::from_str(options_json) {
        Ok(v) => v,
        Err(e) => return format!("{{\"error\": \"options parse error: {}\"}}", e),
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut retar = VillageRetar::new(vs, setup_raw, options);
        retar.analyze()
    }));
    let result = match result {
        Ok(r) => r,
        Err(e) => {
            let msg = if let Some(s) = e.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = e.downcast_ref::<&str>() {
                s.to_string()
            } else {
                "unknown panic".to_string()
            };
            return format!("{{\"error\": \"panic: {}\"}}", msg);
        }
    };

    // Serialize result: {"possibilities": {"1": ["seer"], ...}, "maxSurvivingNV": N}
    let possibilities: HashMap<String, Vec<SystemRole>> = result
        .result
        .into_iter()
        .map(|(seat, roles)| {
            let mut role_vec: Vec<SystemRole> = roles.into_iter().collect();
            role_vec.sort_by_key(|r| r.bit_index());
            (seat.to_string(), role_vec)
        })
        .collect();

    let output = serde_json::json!({
        "possibilities": possibilities,
        "maxSurvivingNV": result.max_surviving_nv,
    });

    serde_json::to_string(&output).unwrap_or_else(|e| format!("{{\"error\": \"{}\"}}", e))
}

/// Non-WASM entry point for direct Rust usage
pub fn analyze_direct(
    vs: VillageStatus,
    setup: HashMap<SystemRole, u32>,
    options: AnalyzeOptions,
) -> HashMap<Seat, HashSet<SystemRole>> {
    let mut retar = VillageRetar::new(vs, setup, options);
    let result = retar.analyze();
    result.result
}

