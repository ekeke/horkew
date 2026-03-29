use crate::types::{CauseOfDeath, VillageStatus, VillageResult, SystemRole, Seat, Day};
use crate::possibilities::Possibilities;
use crate::role_testers::AnalyzeContext;
use crate::solver::solve_possibilities;
use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct DebugStash {
    pub finalizer_runs: u32,
    pub finalizer_middle: u32,
    pub finalizer_passes: u32,
    pub finalizer_fails: u32,
    pub seer_tests: u32,
    pub medium_tests: u32,
    pub bodyguard_tests: u32,
    pub mason_tests: u32,
    pub nekomata_tests: u32,
    pub werehamster_tests: u32,
    pub seer_test_passes: u32,
    pub medium_test_passes: u32,
    pub bodyguard_test_passes: u32,
    pub mason_test_passes: u32,
    pub nekomata_test_passes: u32,
    pub werehamster_test_passes: u32,
    pub pre_finalize_tests: u32,
    pub pre_finalize_passes: u32,
}

/// Hamster win path for 2-pass analysis
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HamsterWinPath {
    Village,
    Wolf,
}

/// Validate night death counts against role hypotheses.
pub fn constrain_by_death_counts(
    context: &AnalyzeContext,
    vs: &VillageStatus,
    night_kills_by_day: &HashMap<Day, Vec<Seat>>,
    setup: &HashMap<SystemRole, u32>,
) -> bool {
    for (&day, killed) in night_kills_by_day {
        if vs.day <= day {
            continue;
        }
        let add_count = context.death_chronicle.add[day as usize];
        let mut expected: i32 = 1;
        if add_count != 0 {
            expected += add_count as i32;
        }
        let actual = killed.len() as i32;
        let immoralists = setup.get(&SystemRole::Immoralist).copied().unwrap_or(0) as i32;
        if actual == expected {
            continue;
        }
        if expected + immoralists < actual {
            return false;
        } else if actual < expected - 1 {
            return false;
        } else if expected < actual && actual <= expected + immoralists {
            let hamster_died_this_night = context
                .hamsters_killed_by_seer
                .iter()
                .any(|h| h.day == day);
            if hamster_died_this_night {
                // Would add requireOneOf constraints, but we're in an immutable check
                // The caller handles this in the mutable version
                continue;
            }
        }
        if actual < expected {
            let mut has_protector = false;
            for (&seat, status) in &vs.statuses {
                if !status.surviving && status.died_day.unwrap_or(0) < day {
                    continue;
                }
                if context.possibilities.has_role(seat, SystemRole::Bodyguard)
                    || context.possibilities.has_role(seat, SystemRole::Werehamster)
                {
                    has_protector = true;
                    break;
                }
            }
            if has_protector {
                continue;
            }
        }
        return false;
    }
    true
}

/// Mutable version that can add requireOneOf constraints
pub fn constrain_by_death_counts_mut(
    context: &mut AnalyzeContext,
    vs: &VillageStatus,
    night_kills_by_day: &HashMap<Day, Vec<Seat>>,
    setup: &HashMap<SystemRole, u32>,
) -> bool {
    for (&day, killed) in night_kills_by_day {
        if vs.day <= day {
            continue;
        }
        let add_count = context.death_chronicle.add[day as usize];
        let mut expected: i32 = 1;
        if add_count != 0 {
            expected += add_count as i32;
        }
        let actual = killed.len() as i32;
        let immoralists = setup.get(&SystemRole::Immoralist).copied().unwrap_or(0) as i32;
        if actual == expected {
            continue;
        }
        if expected + immoralists < actual {
            return false;
        } else if actual < expected - 1 {
            return false;
        } else if expected < actual && actual <= expected + immoralists {
            let hamster_died_this_night = context
                .hamsters_killed_by_seer
                .iter()
                .any(|h| h.day == day);
            if hamster_died_this_night {
                for _ in 0..immoralists {
                    context.require_one_of.push(
                        killed
                            .iter()
                            .map(|&seat| crate::role_testers::SeatRole {
                                seat,
                                role: SystemRole::Immoralist,
                            })
                            .collect(),
                    );
                }
                continue;
            }
        }
        if actual < expected {
            let mut has_protector = false;
            for (&seat, status) in &vs.statuses {
                if !status.surviving && status.died_day.unwrap_or(0) < day {
                    continue;
                }
                if context.possibilities.has_role(seat, SystemRole::Bodyguard)
                    || context.possibilities.has_role(seat, SystemRole::Werehamster)
                {
                    has_protector = true;
                    break;
                }
            }
            if has_protector {
                continue;
            }
        }
        return false;
    }
    true
}

pub fn finalize(
    context: &mut AnalyzeContext,
    vs: &VillageStatus,
    setup: &HashMap<SystemRole, u32>,
    conclusions: &mut Possibilities,
    debug_stash: &mut DebugStash,
    hamster_win_path: Option<HamsterWinPath>,
    cached_survivors: &[Seat],
    cached_surviving_map: &HashMap<Seat, bool>,
) {
    debug_stash.finalizer_runs += 1;

    // Mark night-kill victims as non-wolf
    for (&seat, status) in &vs.statuses {
        if !status.surviving && status.cause_of_death == CauseOfDeath::NightKill {
            if context.possibilities.is_fixed(seat) {
                continue;
            }
            if !context.possibilities.mark_as_human(seat) {
                return;
            }
        }
    }

    if !context.possibilities.refix() {
        return;
    }

    // If candidates == count for a role, fix all
    for (&role, &count) in setup {
        let candidates = context.possibilities.get_possible_seats_for_role(role);
        if (candidates.len() as u32) < count {
            return;
        }
        if candidates.len() as u32 == count {
            for &seat in &candidates {
                if !context.possibilities.fix_role(seat, role) {
                    return;
                }
            }
        }
    }

    if !context.possibilities.refix() {
        return;
    }
    debug_stash.finalizer_middle += 1;

    let survivors = cached_survivors;
    let num_surviving_hamsters = survivors
        .iter()
        .filter(|&&seat| context.possibilities.is_actual_role(seat, SystemRole::Werehamster))
        .count() as u32;

    let wolf_count = setup.get(&SystemRole::Werewolf).copied().unwrap_or(u32::MAX);
    let raw_max = if survivors.len() as u32 > num_surviving_hamsters {
        (survivors.len() as u32 - num_surviving_hamsters - 1) / 2
    } else {
        0
    };
    let max_surviving_wolves = wolf_count.min(raw_max);

    let mut condition = SolveCondition {
        min_surviving_wolves: 1,
        max_surviving_wolves,
        min_surviving_hamsters: 0,
        max_surviving_hamsters: setup.get(&SystemRole::Werehamster).copied().unwrap_or(0),
    };

    if vs.result == Some(VillageResult::WerewolfWon) {
        condition.min_surviving_wolves = max_surviving_wolves + 1;
        condition.max_surviving_wolves = u32::MAX;
        condition.min_surviving_hamsters = 0;
        condition.max_surviving_hamsters = 0;
    } else if vs.result == Some(VillageResult::VillagerWon) {
        condition.min_surviving_wolves = 0;
        condition.max_surviving_wolves = 0;
        condition.min_surviving_hamsters = 0;
        condition.max_surviving_hamsters = 0;
    }

    // All seats fully determined → validate survival counts directly
    let all_fixed = (1..context.possibilities.possibilities.len())
        .all(|i| context.possibilities.is_fixed(i as Seat));

    if all_fixed {
        let mut surv_wolves = 0u32;
        let mut surv_hamsters = 0u32;
        for &seat in survivors {
            if context.possibilities.is_actual_role(seat, SystemRole::Werewolf) {
                surv_wolves += 1;
            }
            if context.possibilities.is_actual_role(seat, SystemRole::Werehamster) {
                surv_hamsters += 1;
            }
        }

        let check = |min_w, max_w, min_h, max_h| {
            surv_wolves >= min_w && surv_wolves <= max_w && surv_hamsters >= min_h && surv_hamsters <= max_h
        };

        if vs.result == Some(VillageResult::WerehamsterWon) {
            if hamster_win_path != Some(HamsterWinPath::Wolf) && check(0, 0, 1, u32::MAX) {
                debug_stash.finalizer_passes += 1;
                conclusions.union(&context.possibilities);
            }
            if hamster_win_path != Some(HamsterWinPath::Village)
                && check(max_surviving_wolves.saturating_add(1), u32::MAX, 1, u32::MAX)
            {
                debug_stash.finalizer_passes += 1;
                conclusions.union(&context.possibilities);
            }
        } else if check(
            condition.min_surviving_wolves,
            condition.max_surviving_wolves,
            condition.min_surviving_hamsters,
            condition.max_surviving_hamsters,
        ) {
            debug_stash.finalizer_passes += 1;
            conclusions.union(&context.possibilities);
        } else {
            debug_stash.finalizer_fails += 1;
        }
        return;
    }

    // Werehamster won: 2-pass
    if vs.result == Some(VillageResult::WerehamsterWon) {
        if hamster_win_path != Some(HamsterWinPath::Wolf) {
            if let Some(conclusion) = solve_possibilities(
                &context.possibilities,
                cached_surviving_map,
                0,
                0,
                1,
                u32::MAX,
                setup,
            ) {
                debug_stash.finalizer_passes += 1;
                conclusions.union(&conclusion);
            }
        }
        if hamster_win_path != Some(HamsterWinPath::Village) {
            if let Some(conclusion) = solve_possibilities(
                &context.possibilities,
                cached_surviving_map,
                max_surviving_wolves + 1,
                u32::MAX,
                1,
                u32::MAX,
                setup,
            ) {
                debug_stash.finalizer_passes += 1;
                conclusions.union(&conclusion);
            }
        }
    } else {
        let conclusion = solve_possibilities(
            &context.possibilities,
            cached_surviving_map,
            condition.min_surviving_wolves,
            condition.max_surviving_wolves,
            condition.min_surviving_hamsters,
            condition.max_surviving_hamsters,
            setup,
        );
        match conclusion {
            None => {
                debug_stash.finalizer_fails += 1;
            }
            Some(c) => {
                debug_stash.finalizer_passes += 1;
                conclusions.union(&c);
            }
        }
    }
}

struct SolveCondition {
    min_surviving_wolves: u32,
    max_surviving_wolves: u32,
    min_surviving_hamsters: u32,
    max_surviving_hamsters: u32,
}
