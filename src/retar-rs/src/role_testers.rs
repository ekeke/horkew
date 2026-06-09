use crate::types::{CauseOfDeath, EnumSpecies, RoleTrait, SeatStatus, VillageStatus, SystemRole, Seat, Day};
use crate::possibilities::{Possibilities, ROLE_COUNT};
use crate::role_sets::{has_trait, roles_by_trait, single_role_by_seer_result};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

// hot path で繰り返し参照するため module-level lazy 解決. TS roleTesters.ts:6-7 と同じ pattern.
static WOLF_ROLE: LazyLock<SystemRole> = LazyLock::new(|| single_role_by_seer_result(EnumSpecies::Wolf));
static FOX_ROLES: LazyLock<Vec<SystemRole>> = LazyLock::new(|| roles_by_trait(RoleTrait::PassiveDieWhenDivined));

pub struct DeathChronicle {
    pub add: Vec<i8>,
    pub sub: Vec<i8>,
}

impl DeathChronicle {
    pub fn new(size: usize) -> Self {
        DeathChronicle {
            add: vec![0i8; size],
            sub: vec![0i8; size],
        }
    }

    pub fn clone_instance(&self) -> Self {
        DeathChronicle {
            add: self.add.clone(),
            sub: self.sub.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct HamsterKill {
    pub day: Day,
    pub seat: Seat,
}

#[derive(Debug, Clone)]
pub struct SeatRole {
    pub seat: Seat,
    pub role: SystemRole,
}

/// 占いターゲット 1 件: 具体的 seat または不明 ('unknown').
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DivineTarget {
    Seat(Seat),
    Unknown,
}

pub struct AnalyzeContext {
    pub possibilities: Possibilities,
    pub need_divine_alive_at_day: Option<Day>,
    pub hamsters_killed_by_divine: Vec<HamsterKill>,
    pub hamsters_max_surviving_day: i32,
    pub require_one_of: Vec<Vec<SeatRole>>,
    pub death_chronicle: DeathChronicle,
    /// action:divine 持ち全 role の selected 席集合での最大生存日.
    /// alive な席があれば i32::MAX. setup に複数 divine role がある場合 (seer + paparazzi 等)
    /// は trait 単位の集約値. need_divine_alive_at_day と比較して「狐呪殺日に占い能力者が
    /// 生きていたか」を集約的に判定する.
    pub divine_alive_max_day: i32,
    /// action:divine 持ち全 role の selected 席による占いターゲットを日ごとに集約.
    /// - trusted role (faction = village, 例: seer): 公開アサーション / forecast の対象を add
    /// - untrusted role (faction != village, 例: paparazzi): 判定を信用せず Unknown を add
    pub divine_targets_by_day: BTreeMap<Day, BTreeSet<DivineTarget>>,
}

pub struct RoleTesterEnv<'a> {
    pub vs: &'a VillageStatus,
    pub night_kills_by_day: &'a BTreeMap<Day, Vec<Seat>>,
    pub total_liar_roles: u32,
    pub known_fake_claim_count: u32,
    pub last_hamster_must_die_at: Option<Day>,
    pub last_hamster_must_died_by: Option<CauseOfDeath>,
    pub day_count_from: Day,
}

pub struct ContextSnapshot {
    pub poss_arr: Vec<u16>,
    pub poss_setup: [u8; ROLE_COUNT],
    pub hamsters_max_surviving_day: i32,
    pub need_divine_alive_at_day: Option<Day>,
    pub hamsters_killed_by_divine_len: usize,
    pub require_one_of_len: usize,
    pub death_chronicle_add: Vec<i8>,
    pub death_chronicle_sub: Vec<i8>,
    pub divine_alive_max_day: i32,
    pub divine_targets_by_day: BTreeMap<Day, BTreeSet<DivineTarget>>,
}

impl ContextSnapshot {
    /// Pre-allocate a snapshot with the given buffer sizes (no data copied yet).
    pub fn new_empty(poss_len: usize, chronicle_len: usize) -> Self {
        ContextSnapshot {
            poss_arr: vec![0u16; poss_len],
            poss_setup: [0u8; ROLE_COUNT],
            hamsters_max_surviving_day: 0,
            need_divine_alive_at_day: None,
            hamsters_killed_by_divine_len: 0,
            require_one_of_len: 0,
            death_chronicle_add: vec![0i8; chronicle_len],
            death_chronicle_sub: vec![0i8; chronicle_len],
            divine_alive_max_day: i32::MIN,
            divine_targets_by_day: BTreeMap::new(),
        }
    }
}

pub fn save_context(ctx: &AnalyzeContext) -> ContextSnapshot {
    ContextSnapshot {
        poss_arr: ctx.possibilities.possibilities.clone(),
        poss_setup: ctx.possibilities.setup,
        hamsters_max_surviving_day: ctx.hamsters_max_surviving_day,
        need_divine_alive_at_day: ctx.need_divine_alive_at_day,
        hamsters_killed_by_divine_len: ctx.hamsters_killed_by_divine.len(),
        require_one_of_len: ctx.require_one_of.len(),
        death_chronicle_add: ctx.death_chronicle.add.clone(),
        death_chronicle_sub: ctx.death_chronicle.sub.clone(),
        divine_alive_max_day: ctx.divine_alive_max_day,
        divine_targets_by_day: ctx.divine_targets_by_day.clone(),
    }
}

/// Save context into a pre-allocated snapshot (zero heap allocation for primitives).
pub fn save_into(snapshot: &mut ContextSnapshot, ctx: &AnalyzeContext) {
    snapshot.poss_arr.copy_from_slice(&ctx.possibilities.possibilities);
    snapshot.poss_setup = ctx.possibilities.setup;
    snapshot.hamsters_max_surviving_day = ctx.hamsters_max_surviving_day;
    snapshot.need_divine_alive_at_day = ctx.need_divine_alive_at_day;
    snapshot.hamsters_killed_by_divine_len = ctx.hamsters_killed_by_divine.len();
    snapshot.require_one_of_len = ctx.require_one_of.len();
    snapshot.death_chronicle_add.copy_from_slice(&ctx.death_chronicle.add);
    snapshot.death_chronicle_sub.copy_from_slice(&ctx.death_chronicle.sub);
    snapshot.divine_alive_max_day = ctx.divine_alive_max_day;
    snapshot.divine_targets_by_day = ctx.divine_targets_by_day.clone();
}

pub fn restore_context(ctx: &mut AnalyzeContext, s: &ContextSnapshot) {
    ctx.possibilities.possibilities.copy_from_slice(&s.poss_arr);
    ctx.possibilities.setup = s.poss_setup;
    ctx.hamsters_max_surviving_day = s.hamsters_max_surviving_day;
    ctx.need_divine_alive_at_day = s.need_divine_alive_at_day;
    ctx.hamsters_killed_by_divine.truncate(s.hamsters_killed_by_divine_len);
    ctx.require_one_of.truncate(s.require_one_of_len);
    ctx.death_chronicle.add.copy_from_slice(&s.death_chronicle_add);
    ctx.death_chronicle.sub.copy_from_slice(&s.death_chronicle_sub);
    ctx.divine_alive_max_day = s.divine_alive_max_day;
    ctx.divine_targets_by_day = s.divine_targets_by_day.clone();
}

fn get_status<'a>(env: &'a RoleTesterEnv, seat: Seat) -> &'a SeatStatus {
    env.vs.statuses.get(&seat).unwrap()
}

fn deny_role_for_others(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, role: SystemRole, exclude: &BTreeSet<Seat>) -> bool {
    for &seat in env.vs.statuses.keys() {
        if exclude.contains(&seat) {
            continue;
        }
        if !ctx.possibilities.deny_role(seat, role) {
            return false;
        }
    }
    true
}

fn is_exec_phase(c: CauseOfDeath) -> bool {
    c == CauseOfDeath::Execution || c == CauseOfDeath::CursedByExecutedNekomata
}

#[derive(Debug, Clone)]
enum SeerTarget {
    Known(Seat),
    Unknown,
}

// ============================================================================
// trait verifiers
//
// 各 verifier は「trait に対応する能力・性質」を検証する。
// test_role が role に紐付く traits を見て該当 verifier を順次呼び出す。
// 前提: selected の seat は test_role 側で既に fix_role 済み。
// ============================================================================

/// passive: attack-immune + die-when-divined (旧 test_hamster 相当、狐の生存/呪殺制約)
fn verify_hamster_passive(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat], role: SystemRole) -> bool {
    let mut last_hamster_died_at: i32 = i32::MIN;
    let mut last_hamster_died_by: Option<CauseOfDeath> = None;
    let mut living_hamsters = 0u32;
    let mut divine_killed_hamster_at: i32 = i32::MIN;

    for &seat in selected {
        let status = get_status(env, seat);
        if status.surviving {
            living_hamsters += 1;
        } else {
            if status.cause_of_death == CauseOfDeath::NightKill {
                let died_day = status.died_day.unwrap();
                ctx.death_chronicle.add[died_day as usize] += 1;
                ctx.hamsters_killed_by_divine.push(HamsterKill { day: died_day, seat });
                if divine_killed_hamster_at < died_day {
                    divine_killed_hamster_at = died_day;
                }
            }
            let died_day = status.died_day.unwrap();
            if last_hamster_died_at < died_day {
                last_hamster_died_at = died_day;
                last_hamster_died_by = Some(status.cause_of_death);
            }
        }
    }

    if divine_killed_hamster_at >= 0 {
        ctx.need_divine_alive_at_day = Some(divine_killed_hamster_at);
    }

    if let Some(must_die_at) = env.last_hamster_must_die_at {
        if last_hamster_died_at != must_die_at {
            return false;
        }
        if let (Some(actual), Some(expected)) = (last_hamster_died_by, env.last_hamster_must_died_by) {
            if actual != expected {
                if !is_exec_phase(actual) || !is_exec_phase(expected) {
                    return false;
                }
            }
        }
    }

    for &seat in rest {
        ctx.possibilities.deny_role(seat, role);
        if living_hamsters == 0 {
            let status = get_status(env, seat);
            if status.surviving || last_hamster_died_at < status.died_day.unwrap_or(i32::MAX) {
                // 後追い (reactive:follow-fox-death) trait を持つ役職を deny. TS roleTesters.ts:135-138 と同じ.
                for &follow_fox in SystemRole::ALL.iter() {
                    if has_trait(follow_fox, RoleTrait::ReactiveFollowFoxDeath) {
                        ctx.possibilities.deny_role(seat, follow_fox);
                    }
                }
            }
        }
    }

    if living_hamsters > 0 {
        ctx.hamsters_max_surviving_day = i32::MAX;
    } else {
        ctx.hamsters_max_surviving_day = last_hamster_died_at;
    }
    true
}

/// action:divine 持ち role の selected 席を ctx.divine_targets_by_day の指定日に追加.
fn add_divine_target(ctx: &mut AnalyzeContext, day: Day, target: DivineTarget) {
    ctx.divine_targets_by_day.entry(day).or_default().insert(target);
}

/// action: divine (旧 test_seer 相当、占い能力者の assertion 検証 + 狐呪殺).
///
/// trusted (faction == Village, 例: seer): 占い判定を信用し、 wolf-fix / fox 呪殺判定を実施.
///   さらに対象を ctx.divine_targets_by_day に集約する.
/// untrusted (faction != Village, 例: paparazzi): 判定を信用しない. selected が active だった
///   夜は ctx.divine_targets_by_day に Unknown を add するに留める.
///
/// 「狐死日に占い能力者が生きていた + 対象が含まれる」の集約検証は finalize の check_divine_coverage
/// に委譲する (複数 divine role の selected を横断するため).
fn verify_divine_ability(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat], role: SystemRole) -> bool {
    let mut seers = BTreeSet::new();
    let is_trusted = role.faction() == crate::types::Faction::Village;

    for &seat in selected {
        seers.insert(seat);
        let self_status = get_status(env, seat);

        // 集約: selected の生存日を divine_alive_max_day に Math.max で反映
        let self_max_day = if self_status.surviving {
            i32::MAX
        } else {
            self_status.died_day.unwrap()
        };
        if ctx.divine_alive_max_day < self_max_day {
            ctx.divine_alive_max_day = self_max_day;
        }

        let max_active_day = if self_status.surviving {
            env.vs.day - 1
        } else if self_status.cause_of_death == CauseOfDeath::NightKill {
            self_status.died_day.unwrap()
        } else {
            self_status.died_day.unwrap() - 1
        };

        if !is_trusted {
            // untrusted (paparazzi 等): 判定を信用しない. active な夜全てに Unknown を集約.
            for d in env.day_count_from..=max_active_day {
                add_divine_target(ctx, d, DivineTarget::Unknown);
            }
            continue;
        }

        // ===== trusted (seer 等) =====
        // local seer_targets: この role の selected 席が day d に占った先
        let mut seer_targets: BTreeMap<Day, Vec<SeerTarget>> = BTreeMap::new();

        // Populate seer_targets from assertions
        for (&night, assertion) in &self_status.assertions {
            if night < 0 {
                continue;
            }
            seer_targets
                .entry(night)
                .or_default()
                .push(SeerTarget::Known(assertion.target));
        }
        // If seer died at night, they acted that night but result is unreported
        if !self_status.surviving && self_status.cause_of_death == CauseOfDeath::NightKill {
            let died_day = self_status.died_day.unwrap();
            let forecast_target = self_status.forecasts.get(&died_day);
            let target = match forecast_target {
                Some(&t) => SeerTarget::Known(t),
                None => SeerTarget::Unknown,
            };
            seer_targets.entry(died_day).or_default().push(target);
        }
        // Add 'unknown' for unreported nights
        for d in env.day_count_from..=max_active_day {
            if !seer_targets.contains_key(&d) {
                let target = match self_status.forecasts.get(&d) {
                    Some(&t) => SeerTarget::Known(t),
                    None => SeerTarget::Unknown,
                };
                seer_targets.entry(d).or_default().push(target);
            }
        }

        // Process assertions
        for (&assertion_night, assertion) in &self_status.assertions {
            if assertion.species == Some(crate::types::EnumSpecies::Wolf) {
                if !ctx.possibilities.fix_role(assertion.target, *WOLF_ROLE) {
                    return false;
                }
                let target_status = get_status(env, assertion.target);
                if !target_status.surviving && target_status.cause_of_death == CauseOfDeath::NightKill {
                    let night_kills = env.night_kills_by_day.get(&target_status.died_day.unwrap());
                    if let Some(kills) = night_kills {
                        if kills.len() <= 1 {
                            return false;
                        }
                    }
                }
            } else if FOX_ROLES.iter().any(|&r| ctx.possibilities.is_actual_role(assertion.target, r)) {
                let target_status = get_status(env, assertion.target);
                if target_status.surviving {
                    return false;
                }
                if assertion_night >= 0 && target_status.died_day != Some(assertion_night) {
                    return false;
                }
                let targets_on_death_day = seer_targets.get(&target_status.died_day.unwrap());
                match targets_on_death_day {
                    None => return false,
                    Some(targets) => {
                        let has_target = targets.iter().any(|t| match t {
                            SeerTarget::Known(s) => *s == assertion.target,
                            SeerTarget::Unknown => true,
                        });
                        if !has_target {
                            return false;
                        }
                    }
                }
            } else {
                if !ctx.possibilities.mark_as_human(assertion.target) {
                    return false;
                }
            }
        }

        // Forecast targets with unreported results
        for (&night, &forecast_target) in &self_status.forecasts {
            if night < env.day_count_from || night > max_active_day {
                continue;
            }
            if self_status.assertions.contains_key(&night) {
                continue;
            }
            if FOX_ROLES.iter().any(|&r| ctx.possibilities.is_actual_role(forecast_target, r)) {
                let target_status = get_status(env, forecast_target);
                if target_status.surviving {
                    return false;
                }
                if target_status.died_day != Some(night) {
                    return false;
                }
                let targets_on_death_day = seer_targets.get(&target_status.died_day.unwrap());
                match targets_on_death_day {
                    None => return false,
                    Some(targets) => {
                        let has_target = targets.iter().any(|t| match t {
                            SeerTarget::Known(s) => *s == forecast_target,
                            SeerTarget::Unknown => true,
                        });
                        if !has_target {
                            return false;
                        }
                    }
                }
            }
        }

        // 集約: trusted role の local seer_targets を ctx.divine_targets_by_day に push
        for (day, targets) in seer_targets {
            for t in targets {
                let dt = match t {
                    SeerTarget::Known(s) => DivineTarget::Seat(s),
                    SeerTarget::Unknown => DivineTarget::Unknown,
                };
                add_divine_target(ctx, day, dt);
            }
        }
    }

    for &seat in rest {
        let status = get_status(env, seat);
        if !status.claiming {
            if !ctx.possibilities.deny_role(seat, role) {
                return false;
            }
        } else if is_trusted {
            // trusted (seer): 同 role CO 席は偽者扱い (liar 役職に絞る)
            if !ctx.possibilities.mark_as_liar(seat) {
                return false;
            }
        } else {
            // untrusted (paparazzi 等): seer 騙りなので rest 内の seer CO は真者の可能性が残る → 触らない.
            // ただし claiming_role が自分と同じ場合は偽 CO として markAsLiar.
            if status.claiming_role == role.to_string() {
                if !ctx.possibilities.mark_as_liar(seat) {
                    return false;
                }
            }
        }
    }

    if !deny_role_for_others(env, ctx, role, &seers) {
        return false;
    }
    true
}

/// auto-info: execution-species (旧 test_medium 相当、霊媒結果の検証)
fn verify_mediumship_ability(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat], role: SystemRole) -> bool {
    let mut mediums = BTreeSet::new();
    let role_name = role.to_string();
    for &seat in selected {
        mediums.insert(seat);
        let self_status = get_status(env, seat);
        for (_, assertion) in &self_status.assertions {
            if assertion.species == Some(crate::types::EnumSpecies::Wolf) {
                if !ctx.possibilities.fix_role(assertion.target, *WOLF_ROLE) {
                    return false;
                }
            } else {
                // 霊媒結果 ○ は mediumResult: 'human' 集合 (werewolf と kogitsune 以外) に絞る.
                // 占い ○ の mark_as_human (seerResult: 'human') と違って kogitsune は除外される.
                if !ctx.possibilities.mark_as_medium_human(assertion.target) {
                    return false;
                }
            }
        }
    }
    for &seat in rest {
        let status = get_status(env, seat);
        if !status.claiming || status.claiming_role != role_name {
            if !ctx.possibilities.deny_role(seat, role) {
                return false;
            }
        } else {
            if !ctx.possibilities.mark_as_liar(seat) {
                return false;
            }
        }
    }
    if !deny_role_for_others(env, ctx, role, &mediums) {
        return false;
    }
    true
}

/// action: guard (旧 test_bodyguard 相当、護衛能力者の rest 処理のみ — assertion 検証なし)
fn verify_guard_ability(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat], role: SystemRole) -> bool {
    let mut bodyguards = BTreeSet::new();
    let role_name = role.to_string();
    for &seat in selected {
        bodyguards.insert(seat);
    }
    for &seat in rest {
        let status = get_status(env, seat);
        if !status.claiming || status.claiming_role != role_name {
            if !ctx.possibilities.deny_role(seat, role) {
                return false;
            }
        } else {
            if !ctx.possibilities.mark_as_liar(seat) {
                return false;
            }
        }
    }
    if !deny_role_for_others(env, ctx, role, &bodyguards) {
        return false;
    }
    true
}

/// knowledge: know-masons (旧 test_mason 相当、共有相方の固定)
fn verify_mason_bond(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat], role: SystemRole) -> bool {
    let mut masons = BTreeSet::new();
    let role_name = role.to_string();
    for &seat in selected {
        masons.insert(seat);
        let self_status = get_status(env, seat);
        for (_, assertion) in &self_status.assertions {
            if assertion.species == Some(crate::types::EnumSpecies::Wolf) {
                // Mason asserts partner as human. Wolf assertion → contradiction.
                return false;
            } else {
                if !ctx.possibilities.fix_role(assertion.target, role) {
                    return false;
                }
                masons.insert(assertion.target);
            }
        }
    }
    for &seat in rest {
        let status = get_status(env, seat);
        if !status.claiming || status.claiming_role != role_name {
            continue;
        }
        if !ctx.possibilities.mark_as_liar(seat) {
            return false;
        }
    }
    if !deny_role_for_others(env, ctx, role, &masons) {
        return false;
    }
    true
}

/// reactive: curse-on-executed + curse-on-killed (旧 test_nekomata 相当、道連れ検証)
fn verify_nekomata_curse(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat], role: SystemRole) -> bool {
    let mut nekomatas = BTreeSet::new();
    let mut possible_cursed: Vec<Seat> = Vec::new();
    let role_name = role.to_string();

    for &seat in selected {
        nekomatas.insert(seat);
        let self_status = get_status(env, seat);
        if !self_status.surviving {
            if self_status.cause_of_death == CauseOfDeath::NightKill {
                ctx.death_chronicle.add[self_status.died_day.unwrap() as usize] += 1;
            }
            let mut ok = false;
            for (&target_seat, target_status) in &env.vs.statuses {
                if target_status.surviving {
                    continue;
                }
                if target_status.died_day != self_status.died_day {
                    continue;
                }
                if target_status.cause_of_death == CauseOfDeath::Execution {
                    continue;
                }
                if target_status.cause_of_death == CauseOfDeath::FollowExecutedHamster
                    || target_status.cause_of_death == CauseOfDeath::FollowKilledHamster
                {
                    continue;
                }
                if target_seat == seat {
                    continue;
                }
                // Another body found on the same day
                if self_status.cause_of_death == CauseOfDeath::Execution {
                    if target_status.cause_of_death == CauseOfDeath::CursedByExecutedNekomata {
                        ok = true;
                        break;
                    }
                } else {
                    ok = true;
                    if target_status.cause_of_death == CauseOfDeath::CursedByKilledNekomata {
                        if !ctx.possibilities.fix_role(target_seat, *WOLF_ROLE) {
                            return false;
                        }
                    }
                    possible_cursed.push(target_seat);
                }
            }
            if !ok {
                return false;
            }
        }
    }

    if !possible_cursed.is_empty() {
        ctx.require_one_of.push(
            possible_cursed
                .iter()
                .map(|&seat| SeatRole {
                    seat,
                    role: *WOLF_ROLE,
                })
                .collect(),
        );
    }

    for &seat in rest {
        let status = get_status(env, seat);
        if !status.claiming || status.claiming_role != role_name {
            if !ctx.possibilities.deny_role(seat, role) {
                return false;
            }
        } else {
            if !ctx.possibilities.mark_as_liar(seat) {
                return false;
            }
        }
    }
    if !deny_role_for_others(env, ctx, role, &nekomatas) {
        return false;
    }
    true
}

// ============================================================================
// test_role: trait ベース dispatcher
// 新役職は SystemRole::traits() に traits を追加するだけで自動的にここから対応 verifier に分配される。
// ============================================================================

pub fn test_role(
    env: &RoleTesterEnv,
    ctx: &mut AnalyzeContext,
    role: SystemRole,
    selected: &[Seat],
    rest: &[Seat],
) -> bool {
    // 1. selected を role に固定
    for &seat in selected {
        if !ctx.possibilities.fix_role(seat, role) {
            return false;
        }
    }

    // 2. role の traits に応じた verifier を順次呼ぶ
    let traits = role.traits();

    if traits.contains(&RoleTrait::PassiveAttackImmune) || traits.contains(&RoleTrait::PassiveDieWhenDivined) {
        if !verify_hamster_passive(env, ctx, selected, rest, role) {
            return false;
        }
    }
    if traits.contains(&RoleTrait::ActionDivine) {
        if !verify_divine_ability(env, ctx, selected, rest, role) {
            return false;
        }
    }
    if traits.contains(&RoleTrait::AutoInfoExecutionSpecies) {
        if !verify_mediumship_ability(env, ctx, selected, rest, role) {
            return false;
        }
    }
    if traits.contains(&RoleTrait::ActionGuard) {
        if !verify_guard_ability(env, ctx, selected, rest, role) {
            return false;
        }
    }
    if traits.contains(&RoleTrait::KnowledgeKnowMasons) {
        if !verify_mason_bond(env, ctx, selected, rest, role) {
            return false;
        }
    }
    if traits.contains(&RoleTrait::ReactiveCurseOnExecuted) || traits.contains(&RoleTrait::ReactiveCurseOnKilled) {
        if !verify_nekomata_curse(env, ctx, selected, rest, role) {
            return false;
        }
    }

    true
}
