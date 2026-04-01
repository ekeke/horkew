use wasm_bindgen::prelude::*;
use std::collections::{BTreeMap, BTreeSet};

pub mod types;
pub mod possibilities;
pub mod combinatorics;
pub mod solver;
pub mod role_testers;
pub mod plan_builder;
pub mod finalizer;
pub mod village_retar;
pub mod dump;

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
    let setup_raw: BTreeMap<SystemRole, u32> = match serde_json::from_str(setup_json) {
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

    // Serialize result matching JS AnalyzeResult shape
    let result_map: BTreeMap<String, Vec<SystemRole>> = result
        .result
        .into_iter()
        .map(|(seat, roles)| {
            let mut role_vec: Vec<SystemRole> = roles.into_iter().collect();
            role_vec.sort_by_key(|r| r.bit_index());
            (seat.to_string(), role_vec)
        })
        .collect();

    let output = serde_json::json!({
        "result": result_map,
        "maxSurvivingNV": result.max_surviving_nv,
        "elapsed": result.elapsed_ms,
        "batch": result.batch,
        "id": result.id,
        "aborted": result.aborted,
    });

    serde_json::to_string(&output).unwrap_or_else(|e| format!("{{\"error\": \"{}\"}}", e))
}

/// WASM entry point with dump: returns JSON with both result and dump lines.
/// Only available when compiled with feature "dump".
#[cfg(feature = "dump")]
#[wasm_bindgen]
pub fn analyze_with_dump(village_json: &str, setup_json: &str, options_json: &str) -> String {
    console_error_panic_hook::set_once();

    let vs: VillageStatus = match serde_json::from_str(village_json) {
        Ok(v) => v,
        Err(e) => return format!("{{\"error\": \"village parse error: {}\"}}", e),
    };
    let setup_raw: BTreeMap<SystemRole, u32> = match serde_json::from_str(setup_json) {
        Ok(v) => v,
        Err(e) => return format!("{{\"error\": \"setup parse error: {}\"}}", e),
    };
    let options: AnalyzeOptions = match serde_json::from_str(options_json) {
        Ok(v) => v,
        Err(e) => return format!("{{\"error\": \"options parse error: {}\"}}", e),
    };

    dump::reset();
    dump::enable();

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut retar = VillageRetar::new(vs, setup_raw, options);
        retar.analyze()
    }));

    dump::disable();
    let dump_lines = dump::get_dump();

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
            return format!("{{\"error\": \"panic: {}\", \"dump\": []}}", msg);
        }
    };

    let result_map: BTreeMap<String, Vec<SystemRole>> = result
        .result
        .into_iter()
        .map(|(seat, roles)| {
            let mut role_vec: Vec<SystemRole> = roles.into_iter().collect();
            role_vec.sort_by_key(|r| r.bit_index());
            (seat.to_string(), role_vec)
        })
        .collect();

    let output = serde_json::json!({
        "result": result_map,
        "maxSurvivingNV": result.max_surviving_nv,
        "elapsed": result.elapsed_ms,
        "batch": result.batch,
        "id": result.id,
        "aborted": result.aborted,
        "dump": dump_lines,
    });

    serde_json::to_string(&output).unwrap_or_else(|e| format!("{{\"error\": \"{}\"}}", e))
}

/// Non-WASM entry point for direct Rust usage
pub fn analyze_direct(
    vs: VillageStatus,
    setup: BTreeMap<SystemRole, u32>,
    options: AnalyzeOptions,
) -> BTreeMap<Seat, BTreeSet<SystemRole>> {
    let mut retar = VillageRetar::new(vs, setup, options);
    let result = retar.analyze();
    result.result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_13597_execution_curse() {
        let vs_json = include_str!("../13597_vs.json");
        let setup_json = include_str!("../13597_setup.json");
        let options_json = include_str!("../13597_options.json");

        let vs: VillageStatus = serde_json::from_str(vs_json).unwrap();
        let setup: BTreeMap<SystemRole, u32> = serde_json::from_str(setup_json).unwrap();
        let options: AnalyzeOptions = serde_json::from_str(options_json).unwrap();

        let mut retar = VillageRetar::new(vs, setup, options);
        let result = retar.analyze();

        let seat3 = result.result.get(&3).expect("seat 3 should exist");
        assert!(!seat3.is_empty(), "seat 3 should have role possibilities, got: {:?}", seat3);
    }

    #[test]
    fn test_standard_10p_s0() {
        let vs_json = include_str!("../std10p_s0_vs.json");
        let setup_json = include_str!("../std10p_s0_setup.json");
        let options_json = include_str!("../std10p_s0_options.json");

        let vs: VillageStatus = serde_json::from_str(vs_json).unwrap();
        let setup: BTreeMap<SystemRole, u32> = serde_json::from_str(setup_json).unwrap();
        let options: AnalyzeOptions = serde_json::from_str(options_json).unwrap();

        let mut retar = VillageRetar::new(vs, setup, options);
        let result = retar.analyze();

        eprintln!("debug_stash: {:?}", retar.debug_stash);
        for (seat, roles) in &result.result {
            eprintln!("seat {}: {:?}", seat, roles);
        }

        // JS: seerTests=3, seerTestPasses=2, finalizerRuns=2, preFinalizePasses=2
        // No seat should be empty
        for (&seat, roles) in &result.result {
            assert!(!roles.is_empty(), "seat {} should not be empty", seat);
        }
    }

}
