use crate::types::{CauseOfDeath, VillageStatus, SystemRole, Seat};
use crate::possibilities::Possibilities;
use crate::combinatorics::select_combinations_from_array;
use std::collections::{HashMap, HashSet};

pub const LIAR_ROLES: &[SystemRole] = &[
    SystemRole::Werewolf,
    SystemRole::Werehamster,
    SystemRole::Immoralist,
    SystemRole::Possessed,
    SystemRole::Fanatic,
];

const ROLES_IN_TEST_PLANNING: &[SystemRole] = &[
    SystemRole::Nekomata,
    SystemRole::Mason,
    SystemRole::Seer,
    SystemRole::Medium,
    SystemRole::Bodyguard,
];

#[derive(Debug, Clone)]
pub struct RoleTest {
    pub role: RoleTestRole,
    pub selected: Vec<Seat>,
    pub rest: Vec<Seat>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RoleTestRole {
    Role(SystemRole),
    AllPass,
}

pub struct BuildPlanResult {
    pub role_tests: Vec<Vec<RoleTest>>,
    pub total_liar_roles: u32,
    pub known_fake_claim_count: u32,
}

pub fn build_role_test_plan(
    village: &VillageStatus,
    setup: &HashMap<SystemRole, u32>,
    multiple_victims: &[Seat],
    initial_possibilities: Option<&Possibilities>,
) -> BuildPlanResult {
    let mut num_liars: u32 = 0;

    let mut claims: HashMap<SystemRole, Vec<Seat>> = HashMap::new();
    let mut min_claim_day: HashMap<SystemRole, i32> = HashMap::new();
    for &role in ROLES_IN_TEST_PLANNING {
        claims.insert(role, Vec::new());
        min_claim_day.insert(role, i32::MAX);
    }

    for (&seat, status) in &village.statuses {
        let role_str = &status.claiming_role;
        let role = match role_str.as_str() {
            "nekomata" => Some(SystemRole::Nekomata),
            "mason" => Some(SystemRole::Mason),
            "seer" => Some(SystemRole::Seer),
            "medium" => Some(SystemRole::Medium),
            "bodyguard" => Some(SystemRole::Bodyguard),
            _ => None,
        };
        if let Some(role) = role {
            if status.claiming {
                claims.entry(role).or_default().push(seat);
                let claim_day = status.claimed_at.unwrap_or(i32::MAX);
                let entry = min_claim_day.entry(role).or_insert(i32::MAX);
                *entry = (*entry).min(claim_day);
            }
        }
    }

    let mut pose_as_count_total: u32 = 0;
    for (&role, &count) in setup {
        if LIAR_ROLES.contains(&role) {
            num_liars += count;
        }
        if ROLES_IN_TEST_PLANNING.contains(&role) {
            let claim_count = claims.get(&role).map(|v| v.len()).unwrap_or(0) as u32;
            if claim_count == 0 {
                continue;
            }
            let c = claim_count.saturating_sub(count);
            pose_as_count_total += c;
        }
    }

    let mut role_tests: Vec<Vec<RoleTest>> = Vec::new();

    // Werehamster hypotheses
    // 注意: initialPossibilities で狐候補をフィルタしない。
    // prior パスでは確定席が狐候補から除外されるが、solver の交差検証に必要。
    if let Some(&hamster_count) = setup.get(&SystemRole::Werehamster) {
        if hamster_count > 0 {
            let mut all_seats: Vec<Seat> = village.statuses.keys().cloned().collect();
            all_seats.sort();
            let mut hamster_tests = Vec::new();
            select_combinations_from_array(
                &all_seats,
                hamster_count as usize,
                hamster_count as usize,
                &mut |selected, rest| {
                    hamster_tests.push(RoleTest {
                        role: RoleTestRole::Role(SystemRole::Werehamster),
                        selected: selected.to_vec(),
                        rest: rest.to_vec(),
                    });
                },
            );
            role_tests.push(hamster_tests);
        }
    }

    for &role in ROLES_IN_TEST_PLANNING {
        let role_claims = claims.get(&role).cloned().unwrap_or_default();
        if role != SystemRole::Nekomata && role_claims.is_empty() {
            continue;
        }
        let has_execution_curse = role == SystemRole::Nekomata
            && village.statuses.values().any(|s| s.cause_of_death == CauseOfDeath::CursedByExecutedNekomata);
        if role_claims.is_empty() && multiple_victims.is_empty() && !has_execution_curse {
            continue;
        }
        let num = setup.get(&role).copied().unwrap_or(0);
        if num == 0 {
            continue;
        }

        let mut tests_of_role: Vec<RoleTest> = Vec::new();
        let min_day = min_claim_day.get(&role).copied().unwrap_or(i32::MAX);

        // Unrevealed seats: died before first CO, not claiming, not executed (unless no CO opportunity)
        let mut unrevealed_seats: Vec<Seat> = Vec::new();
        for (&seat, status) in &village.statuses {
            if !status.surviving
                && (status.cause_of_death != crate::types::CauseOfDeath::Execution
                    || status.no_co_opportunity.unwrap_or(false))
                && !status.claiming
                && status.died_day.unwrap_or(i32::MAX) < min_day
            {
                unrevealed_seats.push(seat);
            }
        }

        if role == SystemRole::Nekomata && !multiple_victims.is_empty() {
            for &seat in multiple_victims {
                let status = village.statuses.get(&seat).unwrap();
                if status.died_day.unwrap_or(i32::MAX) < min_day {
                    unrevealed_seats.push(seat);
                }
            }
            if role_claims.is_empty() {
                for (&seat, status) in &village.statuses {
                    if status.surviving && !status.claiming {
                        unrevealed_seats.push(seat);
                    }
                }
            }
        }

        // 処刑道連れ: 処刑された猫又候補を追加
        if role == SystemRole::Nekomata && has_execution_curse {
            for (&seat, status) in &village.statuses {
                if status.cause_of_death == CauseOfDeath::Execution && !status.claiming {
                    let has_curse_on_same_day = village.statuses.values().any(|s| {
                        s.cause_of_death == CauseOfDeath::CursedByExecutedNekomata
                            && s.died_day == status.died_day
                    });
                    if has_curse_on_same_day {
                        unrevealed_seats.push(seat);
                    }
                }
            }
            if role_claims.is_empty() {
                for (&seat, status) in &village.statuses {
                    if status.surviving && !status.claiming {
                        unrevealed_seats.push(seat);
                    }
                }
            }
        }

        if role == SystemRole::Mason {
            // Mason hypothesis generation respecting partner assertions
            let claim_seats = &role_claims;
            let mut alive_candidates: Vec<Seat> = Vec::new();
            for (&seat, status) in &village.statuses {
                if status.surviving && !status.claiming {
                    alive_candidates.push(seat);
                }
            }
            let mason_pool: Vec<Seat> = {
                let mut set: HashSet<Seat> = unrevealed_seats.iter().cloned().collect();
                for &s in &alive_candidates {
                    set.insert(s);
                }
                set.into_iter().collect()
            };

            for &claim_seat in claim_seats {
                let status = village.statuses.get(&claim_seat).unwrap();
                let mut asserted_partners: Vec<Seat> = Vec::new();
                for (_, assertion) in &status.assertions {
                    if assertion.species != Some(crate::types::EnumSpecies::Wolf) {
                        asserted_partners.push(assertion.target);
                    }
                }
                let mut fixed: HashSet<Seat> = HashSet::new();
                fixed.insert(claim_seat);
                for &p in &asserted_partners {
                    fixed.insert(p);
                }
                if fixed.len() > num as usize {
                    continue;
                }
                let remaining_slots = num as usize - fixed.len();
                if remaining_slots == 0 {
                    let rest: Vec<Seat> = {
                        let mut all: HashSet<Seat> = claim_seats.iter().cloned().collect();
                        for &s in &mason_pool {
                            all.insert(s);
                        }
                        all.into_iter().filter(|s| !fixed.contains(s)).collect()
                    };
                    tests_of_role.push(RoleTest {
                        role: RoleTestRole::Role(role),
                        selected: fixed.iter().cloned().collect(),
                        rest,
                    });
                } else {
                    let available: Vec<Seat> = mason_pool
                        .iter()
                        .filter(|s| !fixed.contains(s))
                        .cloned()
                        .collect();
                    select_combinations_from_array(
                        &available,
                        remaining_slots,
                        remaining_slots,
                        &mut |sel, rest_from_combo| {
                            let mut selected: Vec<Seat> = fixed.iter().cloned().collect();
                            selected.extend_from_slice(sel);
                            let mut rest: Vec<Seat> = rest_from_combo.to_vec();
                            for &s in claim_seats {
                                if !fixed.contains(&s) {
                                    rest.push(s);
                                }
                            }
                            tests_of_role.push(RoleTest {
                                role: RoleTestRole::Role(role),
                                selected,
                                rest,
                            });
                        },
                    );
                }
            }
            // All claimers fake hypothesis
            let non_claim_unrevealed: Vec<Seat> = unrevealed_seats
                .iter()
                .filter(|s| !claim_seats.contains(s))
                .cloned()
                .collect();
            if non_claim_unrevealed.len() >= num as usize {
                select_combinations_from_array(
                    &non_claim_unrevealed,
                    num as usize,
                    num as usize,
                    &mut |selected, rest| {
                        let mut full_rest: Vec<Seat> = rest.to_vec();
                        full_rest.extend(claim_seats.iter());
                        tests_of_role.push(RoleTest {
                            role: RoleTestRole::Role(role),
                            selected: selected.to_vec(),
                            rest: full_rest,
                        });
                    },
                );
            }
        } else {
            let pool: Vec<Seat> = {
                let mut set: HashSet<Seat> = role_claims.iter().cloned().collect();
                for &s in &unrevealed_seats {
                    set.insert(s);
                }
                set.into_iter().collect()
            };
            select_combinations_from_array(
                &pool,
                num as usize,
                num as usize,
                &mut |selected, rest| {
                    tests_of_role.push(RoleTest {
                        role: RoleTestRole::Role(role),
                        selected: selected.to_vec(),
                        rest: rest.to_vec(),
                    });
                },
            );
        }

        role_tests.push(tests_of_role);
    }

    // Filter empty test sets
    role_tests.retain(|tests| !tests.is_empty());

    if role_tests.is_empty() {
        role_tests.push(vec![RoleTest {
            role: RoleTestRole::AllPass,
            selected: Vec::new(),
            rest: Vec::new(),
        }]);
    }

    BuildPlanResult {
        role_tests,
        total_liar_roles: num_liars,
        known_fake_claim_count: pose_as_count_total,
    }
}
