use crate::types::{CauseOfDeath, EnumSpecies, RoleTrait, SeatStatus, VillageStatus, VillageResult, SystemRole, Seat, Day};
use crate::possibilities::Possibilities;
use crate::role_testers::{AnalyzeContext, DivineTarget};
use crate::role_sets::{
    count_by_seer_result_in, count_by_trait_in, roles_by_seer_result, roles_with_trait_in,
};
use crate::solver::solve_possibilities;
use std::collections::BTreeMap;
use std::sync::LazyLock;

// hot path で繰り返し参照するため module-level lazy 解決. TS finalizer.ts:14-17 と同じ pattern.
static WOLF_ROLES: LazyLock<Vec<SystemRole>> = LazyLock::new(|| roles_by_seer_result(EnumSpecies::Wolf));

/// seat が夜 `day` の時点で行動可能 (alive) かどうか.
/// 夜 D の cause_of_death = NightKill は「その夜に襲撃で死亡」 = その夜の行動は可能, とみなす
/// (verify_divine_ability の seer max_active_day と同じ流儀).
/// Execution は昼の処刑なので died_day == D でも夜 D は alive ではない.
fn is_alive_at_night(status: &SeatStatus, day: Day) -> bool {
    if status.surviving {
        return true;
    }
    let died = status.died_day.unwrap_or(0);
    if died > day {
        return true;
    }
    if died == day && status.cause_of_death == CauseOfDeath::NightKill {
        return true;
    }
    false
}

const ROLE_COUNT: usize = SystemRole::ALL.len();

#[derive(Debug, Clone)]
pub struct DebugStash {
    pub finalizer_runs: u32,
    pub finalizer_middle: u32,
    pub finalizer_passes: u32,
    pub finalizer_fails: u32,
    pub role_tests: [u32; ROLE_COUNT],
    pub role_test_passes: [u32; ROLE_COUNT],
    pub pre_finalize_tests: u32,
    pub pre_finalize_passes: u32,
}

impl Default for DebugStash {
    fn default() -> Self {
        Self {
            finalizer_runs: 0,
            finalizer_middle: 0,
            finalizer_passes: 0,
            finalizer_fails: 0,
            role_tests: [0; ROLE_COUNT],
            role_test_passes: [0; ROLE_COUNT],
            pre_finalize_tests: 0,
            pre_finalize_passes: 0,
        }
    }
}

pub fn create_debug_stash() -> DebugStash {
    DebugStash::default()
}

/// action:divine trait 集約による狐呪殺の説明可能性チェック (読み取り専用).
///
/// verify_divine_ability が個別 role ごとに溜めた divine_alive_max_day / divine_targets_by_day を
/// 使って、 「狐死日に占い能力者のいずれかが生きていた + その日の対象集合に狐 seat (または
/// Unknown) が含まれる」を判定する.
///
/// paparazzi 等の untrusted divine role がいる setup では、 seer 単独では説明できなくても
/// paparazzi が説明する可能性があるためここで集約判定する.
pub fn check_divine_coverage(context: &AnalyzeContext) -> bool {
    if context.hamsters_killed_by_divine.is_empty() {
        return true;
    }

    // 1. 占い能力者の最大生存日 >= 狐呪殺最終日
    if let Some(need_day) = context.need_divine_alive_at_day {
        if context.divine_alive_max_day < need_day {
            return false;
        }
    }

    // 2. 各狐呪殺について、 その日の divine target 集合に対象 seat (または Unknown) を含む
    for hk in &context.hamsters_killed_by_divine {
        let targets = match context.divine_targets_by_day.get(&hk.day) {
            None => return false,
            Some(t) => t,
        };
        if !targets.contains(&DivineTarget::Seat(hk.seat))
            && !targets.contains(&DivineTarget::Unknown)
        {
            return false;
        }
    }

    true
}

/// Hamster win path for 2-pass analysis
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HamsterWinPath {
    Village,
    Wolf,
}

/// Validate night death counts against role hypotheses.
pub fn check_death_counts(
    context: &AnalyzeContext,
    vs: &VillageStatus,
    night_kills_by_day: &BTreeMap<Day, Vec<Seat>>,
    setup: &BTreeMap<SystemRole, u32>,
) -> bool {
    let guard_roles = roles_with_trait_in(setup, RoleTrait::ActionGuard);
    let fox_roles = roles_with_trait_in(setup, RoleTrait::PassiveDieWhenDivined);
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
        let immoralists = count_by_trait_in(setup, RoleTrait::ReactiveFollowFoxDeath) as i32;
        if actual == expected {
            continue;
        }
        if expected + immoralists < actual {
            return false;
        } else if actual < expected - 1 {
            return false;
        } else if expected < actual && actual <= expected + immoralists {
            let hamster_died_this_night = context
                .hamsters_killed_by_divine
                .iter()
                .any(|h| h.day == day);
            if hamster_died_this_night {
                // Would add requireOneOf constraints, but we're in an immutable check
                // The caller handles this in the mutable version
                continue;
            }
        }
        if actual < expected {
            // peace night (actual < expected) を成立させる説明:
            //   (A) 夜 day に alive な妖狐がいる (狼襲撃先 = 妖狐 → 襲撃免疫で死体なし)
            //   (B) 夜 day に alive な狩人がいる (護衛成功)
            let mut has_protector = false;
            for (&seat, status) in &vs.statuses {
                if !is_alive_at_night(status, day) {
                    continue;
                }
                if guard_roles.iter().any(|&r| context.possibilities.has_role(seat, r))
                    || fox_roles.iter().any(|&r| context.possibilities.has_role(seat, r))
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
pub fn update_death_count_constraints(
    context: &mut AnalyzeContext,
    vs: &VillageStatus,
    night_kills_by_day: &BTreeMap<Day, Vec<Seat>>,
    setup: &BTreeMap<SystemRole, u32>,
) -> bool {
    let guard_roles = roles_with_trait_in(setup, RoleTrait::ActionGuard);
    let guard_count = count_by_trait_in(setup, RoleTrait::ActionGuard);
    let follow_fox_roles = roles_with_trait_in(setup, RoleTrait::ReactiveFollowFoxDeath);
    let fox_roles = roles_with_trait_in(setup, RoleTrait::PassiveDieWhenDivined);
    let fox_count = count_by_trait_in(setup, RoleTrait::PassiveDieWhenDivined);
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
        let immoralists = count_by_trait_in(setup, RoleTrait::ReactiveFollowFoxDeath) as i32;
        if actual == expected {
            continue;
        }
        if expected + immoralists < actual {
            return false;
        } else if actual < expected - 1 {
            return false;
        } else if expected < actual && actual <= expected + immoralists {
            let hamster_died_this_night = context
                .hamsters_killed_by_divine
                .iter()
                .any(|h| h.day == day);
            if hamster_died_this_night {
                for _ in 0..immoralists {
                    context.require_one_of.push(
                        killed
                            .iter()
                            .flat_map(|&seat| {
                                follow_fox_roles.iter().map(move |&role| {
                                    crate::role_testers::SeatRole { seat, role }
                                })
                            })
                            .collect(),
                    );
                }
                continue;
            }
        }
        if actual < expected {
            // peace night (actual < expected) を成立させる説明:
            //   (A) 夜 day に alive な妖狐がいる (狼襲撃先 = 妖狐 → 襲撃免疫で死体なし)
            //   (B) 夜 day に alive な狩人がいる (護衛成功)
            // どちらの可能性も無ければ世界棄却. 片方しか可能性が無い場合, かつ setup の該当 role が
            // 1 体しかいない場合に限り, 「その 1 体は alive 側にいる」 と確定するので, 夜 day に
            // alive でない seat から該当 role を deny する. setup に 2 体以上いる場合は片方が
            // 死んでいても他方が alive なら peace を説明できるため deny できない (例: 狐 2 体構成で
            // 片方が呪殺後、 もう片方が襲撃先になる).
            let mut alive_fox_exists = false;
            let mut alive_guard_exists = false;
            for (&seat, status) in &vs.statuses {
                if !is_alive_at_night(status, day) {
                    continue;
                }
                if fox_roles.iter().any(|&r| context.possibilities.has_role(seat, r)) {
                    alive_fox_exists = true;
                }
                if guard_roles.iter().any(|&r| context.possibilities.has_role(seat, r)) {
                    alive_guard_exists = true;
                }
            }
            if !alive_fox_exists && !alive_guard_exists {
                return false;
            }
            if !alive_fox_exists && guard_count == 1 {
                // 説明は (B) のみ + 狩人は 1 体 → 夜 day に alive でない seat の guard 役職を deny
                let dead_seats: Vec<Seat> = vs
                    .statuses
                    .iter()
                    .filter(|(_, status)| !is_alive_at_night(status, day))
                    .map(|(&seat, _)| seat)
                    .collect();
                for seat in dead_seats {
                    for &r in &guard_roles {
                        if !context.possibilities.deny_role(seat, r) {
                            return false;
                        }
                    }
                }
            }
            if !alive_guard_exists && fox_count == 1 {
                // 説明は (A) のみ + 狐は 1 体 → 夜 day に alive でない seat の fox 役職を deny
                let dead_seats: Vec<Seat> = vs
                    .statuses
                    .iter()
                    .filter(|(_, status)| !is_alive_at_night(status, day))
                    .map(|(&seat, _)| seat)
                    .collect();
                for seat in dead_seats {
                    for &r in &fox_roles {
                        if !context.possibilities.deny_role(seat, r) {
                            return false;
                        }
                    }
                }
            }
            continue;
        }
        return false;
    }
    true
}

pub fn finalize(
    context: &mut AnalyzeContext,
    vs: &VillageStatus,
    setup: &BTreeMap<SystemRole, u32>,
    conclusions: &mut Possibilities,
    debug_stash: &mut DebugStash,
    hamster_win_path: Option<HamsterWinPath>,
    cached_survivors: &[Seat],
    cached_surviving_map: &BTreeMap<Seat, bool>,
) {
    debug_stash.finalizer_runs += 1;
    // 全 divine role の集約済み状態で狐呪殺の説明可能性を最終判定
    if !check_divine_coverage(context) {
        debug_stash.finalizer_fails += 1;
        return;
    }
    #[cfg(feature = "dump")] crate::dump::finalize_pre(&context.possibilities);

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

    if !context.possibilities.propagate_full() {
        return;
    }
    debug_stash.finalizer_middle += 1;

    let survivors = cached_survivors;
    // 狐陣営勝利の生存カウントは passive:fox-win-counter trait を持つ全役職 (妖狐 + 子狐) を対象にする.
    // die-when-divined (= 妖狐のみ) で数えると子狐生存だけで勝った世界線が拾えない.
    let hamster_win_roles = roles_with_trait_in(setup, RoleTrait::PassiveFoxWinCounter);
    let setup_foxes = count_by_trait_in(setup, RoleTrait::PassiveFoxWinCounter);
    // 飽和ライン (max_surviving_wolves) 算出時の hamster 数は候補ベース (has_role) で setup 枠キャップ.
    // 確定数 (is_actual_role) で数えると plan_builder が妖狐しか枝刈り固定しないので子狐は未確定の
    // まま 0 計上され、 「妖狐+子狐 両生存 + 狼 2 + 人間 2 = 飽和」 のような解を取り逃す.
    let possible_surviving_hamsters = setup_foxes.min(
        survivors
            .iter()
            .filter(|&&seat| {
                hamster_win_roles
                    .iter()
                    .any(|&r| context.possibilities.has_role(seat, r))
            })
            .count() as u32,
    );

    // TS finalizer.ts と同じ. setup に wolf 役職が無ければ 0 が返る.
    let wolf_count = count_by_seer_result_in(setup, EnumSpecies::Wolf);
    let raw_max = if survivors.len() as u32 > possible_surviving_hamsters {
        (survivors.len() as u32 - possible_surviving_hamsters - 1) / 2
    } else {
        0
    };
    let max_surviving_wolves = wolf_count.min(raw_max);

    let mut condition = SolveCondition {
        min_surviving_wolves: 1,
        max_surviving_wolves,
        min_surviving_hamsters: 0,
        max_surviving_hamsters: setup_foxes,
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
            if WOLF_ROLES.iter().any(|&r| context.possibilities.is_actual_role(seat, r)) {
                surv_wolves += 1;
            }
            if hamster_win_roles
                .iter()
                .any(|&r| context.possibilities.is_actual_role(seat, r))
            {
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
