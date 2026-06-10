use crate::types::{CauseOfDeath, Faction, VillageStatus, SystemRole, RoleTrait, Seat};
use crate::possibilities::Possibilities;
use crate::combinatorics::select_combinations_from_array;
use crate::role_sets::{
    all_roles_in, liar_roles_in, powered_village_roles_in, has_trait, roles_with_trait_in,
};
use std::collections::{BTreeMap, BTreeSet};

/// claiming_role 文字列から SystemRole に変換する. SystemRole::ALL + Display 派生で
/// systemRoles 拡張に自動追従.
fn role_from_str(s: &str) -> Option<SystemRole> {
    SystemRole::ALL.iter().copied().find(|r| r.to_string() == s)
}

/// action:divine trait を持つ liar role (paparazzi 等). seer 等と同じ planning frame で扱う.
/// 同 trait 内で互いの CO 席を pool として共有 (paparazzi は seer 騙り、 seer は paparazzi 騙り).
fn divine_liar_roles_in(setup: &BTreeMap<SystemRole, u32>) -> Vec<SystemRole> {
    all_roles_in(setup)
        .into_iter()
        .filter(|&r| r.faction() != Faction::Village && has_trait(r, RoleTrait::ActionDivine))
        .collect()
}

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
    setup: &BTreeMap<SystemRole, u32>,
    multiple_victims: &[Seat],
    _initial_possibilities: Option<&Possibilities>,
    hocus_pocus: Option<&BTreeMap<Seat, bool>>,
    assumptions: Option<&BTreeMap<Seat, SystemRole>>,
) -> BuildPlanResult {
    let hocus_seats: Vec<Seat> = hocus_pocus
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();

    // setup 駆動で派生. 役職追加で自動追従.
    // 村陣営の能力持ち + divine trait を持つ liar role (paparazzi 等) を planning 対象に.
    let mut planning_roles = powered_village_roles_in(setup);
    planning_roles.extend(divine_liar_roles_in(setup));

    // announce-fixed 動的追加: 公示で全席が assumption 確定された村陣営役職を
    // planning_roles に追加する経路 (powered_village_roles_in から除外されている
    // contractor 等の公示専用役職用)。 既に planning_roles にある役職は触らず、
    // setup count == assumption seat count の役職のみ追加.
    if let Some(asm) = assumptions {
        if !asm.is_empty() {
            let planning_set: BTreeSet<SystemRole> = planning_roles.iter().copied().collect();
            for (&role, &num) in setup.iter() {
                if num == 0 {
                    continue;
                }
                if planning_set.contains(&role) {
                    continue;
                }
                if role.faction() != Faction::Village {
                    continue;
                }
                let assumed_count = asm.values().filter(|&&r| r == role).count() as u32;
                if assumed_count == num {
                    planning_roles.push(role);
                }
            }
        }
    }

    let planning_roles_set: BTreeSet<SystemRole> = planning_roles.iter().copied().collect();
    let liar_roles_set: BTreeSet<SystemRole> = liar_roles_in(setup).into_iter().collect();
    let fox_roles = roles_with_trait_in(setup, RoleTrait::PassiveDieWhenDivined);

    let mut num_liars: u32 = 0;

    let mut claims: BTreeMap<SystemRole, Vec<Seat>> = BTreeMap::new();
    let mut min_claim_day: BTreeMap<SystemRole, i32> = BTreeMap::new();
    for &role in &planning_roles {
        claims.insert(role, Vec::new());
        min_claim_day.insert(role, i32::MAX);
    }

    for (&seat, status) in &village.statuses {
        let role = match role_from_str(&status.claiming_role) {
            Some(r) if planning_roles_set.contains(&r) => r,
            _ => continue,
        };
        if status.claiming {
            claims.entry(role).or_default().push(seat);
            let claim_day = status.claimed_at.unwrap_or(i32::MAX);
            let entry = min_claim_day.entry(role).or_insert(i32::MAX);
            *entry = (*entry).min(claim_day);
        }
    }

    // action:divine trait を共有する role 同士の CO 席を pool として共有する.
    // 例: paparazzi の selected 候補は seer CO 席 + paparazzi CO 席 + unrevealed.
    // paparazzi は通常 seer 騙りするため、 seer CO 席が paparazzi の真の候補となる.
    let get_divine_claim_pool = |role: SystemRole| -> Vec<Seat> {
        if !has_trait(role, RoleTrait::ActionDivine) {
            return claims.get(&role).cloned().unwrap_or_default();
        }
        let mut set: BTreeSet<Seat> = BTreeSet::new();
        for &other_role in &planning_roles {
            if has_trait(other_role, RoleTrait::ActionDivine) {
                if let Some(seats) = claims.get(&other_role) {
                    for &s in seats {
                        set.insert(s);
                    }
                }
            }
        }
        set.into_iter().collect()
    };

    let get_min_claim_day = |role: SystemRole| -> i32 {
        if !has_trait(role, RoleTrait::ActionDivine) {
            return min_claim_day.get(&role).copied().unwrap_or(i32::MAX);
        }
        let mut m = i32::MAX;
        for &other_role in &planning_roles {
            if has_trait(other_role, RoleTrait::ActionDivine) {
                if let Some(&d) = min_claim_day.get(&other_role) {
                    m = m.min(d);
                }
            }
        }
        m
    };

    let mut pose_as_count_total: u32 = 0;
    for (&role, &count) in setup {
        if liar_roles_set.contains(&role) {
            num_liars += count;
        }
        if planning_roles_set.contains(&role) {
            let claim_count = claims.get(&role).map(|v| v.len()).unwrap_or(0) as u32;
            if claim_count == 0 {
                continue;
            }
            let c = claim_count.saturating_sub(count);
            pose_as_count_total += c;
        }
    }

    let mut role_tests: Vec<Vec<RoleTest>> = Vec::new();

    // 狐 (die-when-divined trait) ハイポセシス
    // 注意: initialPossibilities で狐候補をフィルタしない。
    // prior パスでは確定席が狐候補から除外されるが、solver の交差検証に必要。
    for &fox in &fox_roles {
        let fox_count = setup.get(&fox).copied().unwrap_or(0);
        if fox_count == 0 {
            continue;
        }
        let mut all_seats: Vec<Seat> = village.statuses.keys().cloned().collect();
        all_seats.sort();
        let mut fox_tests = Vec::new();
        select_combinations_from_array(
            &all_seats,
            fox_count as usize,
            fox_count as usize,
            &mut |selected, rest| {
                fox_tests.push(RoleTest {
                    role: RoleTestRole::Role(fox),
                    selected: selected.to_vec(),
                    rest: rest.to_vec(),
                });
            },
        );
        role_tests.push(fox_tests);
    }

    for &role in &planning_roles {
        let has_curse_on_executed = has_trait(role, RoleTrait::ReactiveCurseOnExecuted);
        // divine trait 同士は CO 席を pool 共有 (seer ↔ paparazzi).
        let role_claims = get_divine_claim_pool(role);

        // announce-fixed fast-path: 公示で全席が assumption 確定済み かつ claim 0 役職
        // (= contractor 等の公示専用役職) は、 既存 combinatorics を bypass して
        // selected = 公示席のみの 1 通り plan を直接登録する.
        if let Some(asm) = assumptions {
            if !asm.is_empty() && role_claims.is_empty() {
                let assumed_seats: Vec<Seat> = asm
                    .iter()
                    .filter_map(|(&s, &r)| if r == role { Some(s) } else { None })
                    .collect();
                let num = setup.get(&role).copied().unwrap_or(0) as usize;
                if assumed_seats.len() == num && num > 0 {
                    let assumed_set: BTreeSet<Seat> = assumed_seats.iter().cloned().collect();
                    let rest: Vec<Seat> = village
                        .statuses
                        .keys()
                        .cloned()
                        .filter(|s| !assumed_set.contains(s))
                        .collect();
                    role_tests.push(vec![RoleTest {
                        role: RoleTestRole::Role(role),
                        selected: assumed_seats,
                        rest,
                    }]);
                    continue;
                }
            }
        }

        // HocusPocus は「CO 在り役職への潜伏候補追加」に絞る (= 早期 skip 条件は HocusPocus と独立).
        // CO ゼロ役職に HocusPocus 在りで plan を強制生成すると、 contractor 確定 assumption 等と
        // 矛盾する無駄 plan を全 depth で並べてしまい、 結果として全 world fail で盤面が破綻する.
        if !has_curse_on_executed && role_claims.is_empty() {
            continue;
        }
        let has_execution_curse = has_curse_on_executed
            && village.statuses.values().any(|s| s.cause_of_death == CauseOfDeath::CursedByExecutedNekomata);
        if role_claims.is_empty() && multiple_victims.is_empty() && !has_execution_curse {
            continue;
        }
        let num = setup.get(&role).copied().unwrap_or(0);
        if num == 0 {
            continue;
        }

        let mut tests_of_role: Vec<RoleTest> = Vec::new();
        let min_day = get_min_claim_day(role);

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
        // HocusPocus 指定席は生存/死亡に関わらず全役職の潜伏候補として許容する。
        // apply_hocus_pocus で claiming=false 済みだが、生存席は上記ループに入らないため明示追加する。
        for &hocus_seat in &hocus_seats {
            if !unrevealed_seats.contains(&hocus_seat) {
                unrevealed_seats.push(hocus_seat);
            }
        }

        if has_curse_on_executed && !multiple_victims.is_empty() {
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

        // 処刑道連れ: 処刑された道連れ役職 (猫又) 候補を追加
        if has_curse_on_executed && has_execution_curse {
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

        if has_trait(role, RoleTrait::KnowledgeKnowMasons) {
            // 共有 (mason) ハイポセシス生成: CO 者の相方 assertion を尊重する
            let claim_seats = &role_claims;
            let mut alive_candidates: Vec<Seat> = Vec::new();
            for (&seat, status) in &village.statuses {
                if status.surviving && !status.claiming {
                    alive_candidates.push(seat);
                }
            }
            let mason_pool: Vec<Seat> = {
                let mut set: BTreeSet<Seat> = unrevealed_seats.iter().cloned().collect();
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
                let mut fixed: BTreeSet<Seat> = BTreeSet::new();
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
                        let mut all: BTreeSet<Seat> = claim_seats.iter().cloned().collect();
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
                let mut set: BTreeSet<Seat> = role_claims.iter().cloned().collect();
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
