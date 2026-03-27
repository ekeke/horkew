use crate::types::{CauseOfDeath, SeatStatus, VillageStatus, SystemRole, Seat, Day};
use crate::possibilities::Possibilities;
use std::collections::{HashMap, HashSet};

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

pub struct AnalyzeContext {
    pub possibilities: Possibilities,
    pub need_seer_at_day: Option<Day>,
    pub hamsters_killed_by_seer: Vec<HamsterKill>,
    pub hamsters_max_surviving_day: i32,
    pub require_one_of: Vec<Vec<SeatRole>>,
    pub death_chronicle: DeathChronicle,
}

pub struct RoleTesterEnv<'a> {
    pub vs: &'a VillageStatus,
    pub night_kills_by_day: &'a HashMap<Day, Vec<Seat>>,
    pub total_liar_roles: u32,
    pub known_fake_claim_count: u32,
    pub last_hamster_must_die_at: Option<Day>,
    pub last_hamster_must_died_by: Option<CauseOfDeath>,
    pub day_count_from: Day,
}

pub struct ContextSnapshot {
    pub poss_arr: Vec<u16>,
    pub poss_setup: [u8; 11],
    pub hamsters_max_surviving_day: i32,
    pub need_seer_at_day: Option<Day>,
    pub hamsters_killed_by_seer_len: usize,
    pub require_one_of_len: usize,
    pub death_chronicle_add: Vec<i8>,
    pub death_chronicle_sub: Vec<i8>,
}

pub fn save_context(ctx: &AnalyzeContext) -> ContextSnapshot {
    ContextSnapshot {
        poss_arr: ctx.possibilities.possibilities.clone(),
        poss_setup: ctx.possibilities.setup,
        hamsters_max_surviving_day: ctx.hamsters_max_surviving_day,
        need_seer_at_day: ctx.need_seer_at_day,
        hamsters_killed_by_seer_len: ctx.hamsters_killed_by_seer.len(),
        require_one_of_len: ctx.require_one_of.len(),
        death_chronicle_add: ctx.death_chronicle.add.clone(),
        death_chronicle_sub: ctx.death_chronicle.sub.clone(),
    }
}

pub fn restore_context(ctx: &mut AnalyzeContext, s: &ContextSnapshot) {
    ctx.possibilities.possibilities.copy_from_slice(&s.poss_arr);
    ctx.possibilities.setup = s.poss_setup;
    ctx.hamsters_max_surviving_day = s.hamsters_max_surviving_day;
    ctx.need_seer_at_day = s.need_seer_at_day;
    ctx.hamsters_killed_by_seer.truncate(s.hamsters_killed_by_seer_len);
    ctx.require_one_of.truncate(s.require_one_of_len);
    ctx.death_chronicle.add.copy_from_slice(&s.death_chronicle_add);
    ctx.death_chronicle.sub.copy_from_slice(&s.death_chronicle_sub);
}

fn get_status<'a>(env: &'a RoleTesterEnv, seat: Seat) -> &'a SeatStatus {
    env.vs.statuses.get(&seat).unwrap()
}

fn deny_role_for_others(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, role: SystemRole, exclude: &HashSet<Seat>) -> bool {
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

pub fn test_hamster(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat]) -> bool {
    let mut hamsters = HashSet::new();
    let mut last_hamster_died_at: i32 = i32::MIN;
    let mut last_hamster_died_by: Option<CauseOfDeath> = None;
    let mut living_hamsters = 0u32;
    let mut seer_killed_hamster_at: i32 = i32::MIN;

    for &seat in selected {
        hamsters.insert(seat);
        if !ctx.possibilities.fix_role(seat, SystemRole::Werehamster) {
            return false;
        }
        let status = get_status(env, seat);
        if status.surviving {
            living_hamsters += 1;
        } else {
            if status.cause_of_death == CauseOfDeath::NightKill {
                let died_day = status.died_day.unwrap();
                ctx.death_chronicle.add[died_day as usize] += 1;
                ctx.hamsters_killed_by_seer.push(HamsterKill { day: died_day, seat });
                if seer_killed_hamster_at < died_day {
                    seer_killed_hamster_at = died_day;
                }
            }
            let died_day = status.died_day.unwrap();
            if last_hamster_died_at < died_day {
                last_hamster_died_at = died_day;
                last_hamster_died_by = Some(status.cause_of_death);
            }
        }
    }

    if seer_killed_hamster_at >= 0 {
        ctx.need_seer_at_day = Some(seer_killed_hamster_at);
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
        ctx.possibilities.deny_role(seat, SystemRole::Werehamster);
        if living_hamsters == 0 {
            let status = get_status(env, seat);
            if status.surviving || last_hamster_died_at < status.died_day.unwrap_or(i32::MAX) {
                ctx.possibilities.deny_role(seat, SystemRole::Immoralist);
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

pub fn test_seer(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat]) -> bool {
    let mut seers = HashSet::new();
    let mut max_surviving: i32 = i32::MIN;
    let mut seer_targets: HashMap<Day, Vec<SeerTarget>> = HashMap::new();
    let mut unresolved_hamster_death: HashMap<Day, i32> = HashMap::new();

    if !ctx.hamsters_killed_by_seer.is_empty() {
        for hk in &ctx.hamsters_killed_by_seer {
            *unresolved_hamster_death.entry(hk.day).or_insert(0) += 1;
        }
    }

    for &seat in selected {
        seers.insert(seat);
        if !ctx.possibilities.fix_role(seat, SystemRole::Seer) {
            return false;
        }

        let self_status = get_status(env, seat);

        if !self_status.claiming {
            for (&day, count) in unresolved_hamster_death.iter_mut() {
                if self_status.surviving || self_status.died_day.unwrap_or(0) >= day {
                    *count -= 1;
                }
            }
        }
        if self_status.surviving {
            max_surviving = i32::MAX;
        } else if max_surviving < self_status.died_day.unwrap_or(0) {
            max_surviving = self_status.died_day.unwrap_or(0);
        }

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
        let max_active_day = if self_status.surviving {
            env.vs.day - 1
        } else if self_status.cause_of_death == CauseOfDeath::NightKill {
            self_status.died_day.unwrap()
        } else {
            self_status.died_day.unwrap() - 1
        };
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
                if !ctx.possibilities.fix_role(assertion.target, SystemRole::Werewolf) {
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
            } else if ctx.possibilities.is_actual_role(assertion.target, SystemRole::Werehamster) {
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
            if ctx.possibilities.is_actual_role(forecast_target, SystemRole::Werehamster) {
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
    }

    // Resolve hamster deaths
    for hk in &ctx.hamsters_killed_by_seer {
        if let Some(targets) = seer_targets.get(&hk.day) {
            for target in targets {
                if (hk.day == hk.day) && match target {
                    SeerTarget::Known(s) => *s == hk.seat,
                    SeerTarget::Unknown => true,
                } {
                    if let Some(count) = unresolved_hamster_death.get_mut(&hk.day) {
                        *count -= 1;
                    }
                }
            }
        }
    }
    for &count in unresolved_hamster_death.values() {
        if count > 0 {
            return false;
        }
    }

    if let Some(need_day) = ctx.need_seer_at_day {
        if max_surviving < need_day {
            return false;
        }
    }

    for &seat in rest {
        let status = get_status(env, seat);
        if !status.claiming {
            if !ctx.possibilities.deny_role(seat, SystemRole::Seer) {
                return false;
            }
        } else {
            if !ctx.possibilities.mark_as_liar(seat) {
                return false;
            }
        }
    }

    if !deny_role_for_others(env, ctx, SystemRole::Seer, &seers) {
        return false;
    }
    true
}

#[derive(Debug, Clone)]
enum SeerTarget {
    Known(Seat),
    Unknown,
}

pub fn test_medium(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat]) -> bool {
    let mut mediums = HashSet::new();
    for &seat in selected {
        mediums.insert(seat);
        if !ctx.possibilities.fix_role(seat, SystemRole::Medium) {
            return false;
        }
        let self_status = get_status(env, seat);
        for (_, assertion) in &self_status.assertions {
            if assertion.species == Some(crate::types::EnumSpecies::Wolf) {
                if !ctx.possibilities.fix_role(assertion.target, SystemRole::Werewolf) {
                    return false;
                }
            } else {
                if !ctx.possibilities.mark_as_human(assertion.target) {
                    return false;
                }
            }
        }
    }
    for &seat in rest {
        let status = get_status(env, seat);
        if !status.claiming || status.claiming_role != "medium" {
            if !ctx.possibilities.deny_role(seat, SystemRole::Medium) {
                return false;
            }
        } else {
            if !ctx.possibilities.mark_as_liar(seat) {
                return false;
            }
        }
    }
    if !deny_role_for_others(env, ctx, SystemRole::Medium, &mediums) {
        return false;
    }
    true
}

pub fn test_bodyguard(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat]) -> bool {
    let mut bodyguards = HashSet::new();
    for &seat in selected {
        bodyguards.insert(seat);
        if !ctx.possibilities.fix_role(seat, SystemRole::Bodyguard) {
            return false;
        }
    }
    for &seat in rest {
        let status = get_status(env, seat);
        if !status.claiming || status.claiming_role != "bodyguard" {
            if !ctx.possibilities.deny_role(seat, SystemRole::Bodyguard) {
                return false;
            }
        } else {
            if !ctx.possibilities.mark_as_liar(seat) {
                return false;
            }
        }
    }
    if !deny_role_for_others(env, ctx, SystemRole::Bodyguard, &bodyguards) {
        return false;
    }
    true
}

pub fn test_mason(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat]) -> bool {
    let mut masons = HashSet::new();
    for &seat in selected {
        masons.insert(seat);
        if !ctx.possibilities.fix_role(seat, SystemRole::Mason) {
            return false;
        }
        let self_status = get_status(env, seat);
        for (_, assertion) in &self_status.assertions {
            if assertion.species == Some(crate::types::EnumSpecies::Wolf) {
                // Mason asserts partner as human. Wolf assertion → contradiction.
                return false;
            } else {
                if !ctx.possibilities.fix_role(assertion.target, SystemRole::Mason) {
                    return false;
                }
                masons.insert(assertion.target);
            }
        }
    }
    for &seat in rest {
        let status = get_status(env, seat);
        if !status.claiming || status.claiming_role != "mason" {
            continue;
        }
        if !ctx.possibilities.mark_as_liar(seat) {
            return false;
        }
    }
    if !deny_role_for_others(env, ctx, SystemRole::Mason, &masons) {
        return false;
    }
    true
}

pub fn test_nekomata(env: &RoleTesterEnv, ctx: &mut AnalyzeContext, selected: &[Seat], rest: &[Seat]) -> bool {
    let mut nekomatas = HashSet::new();
    let mut possible_cursed: Vec<Seat> = Vec::new();

    for &seat in selected {
        nekomatas.insert(seat);
        if !ctx.possibilities.fix_role(seat, SystemRole::Nekomata) {
            return false;
        }
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
                        if !ctx.possibilities.fix_role(target_seat, SystemRole::Werewolf) {
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
                    role: SystemRole::Werewolf,
                })
                .collect(),
        );
    }

    for &seat in rest {
        let status = get_status(env, seat);
        if !status.claiming || status.claiming_role != "nekomata" {
            if !ctx.possibilities.deny_role(seat, SystemRole::Nekomata) {
                return false;
            }
        } else {
            if !ctx.possibilities.mark_as_liar(seat) {
                return false;
            }
        }
    }
    if !deny_role_for_others(env, ctx, SystemRole::Nekomata, &nekomatas) {
        return false;
    }
    true
}

pub fn test_role(
    env: &RoleTesterEnv,
    ctx: &mut AnalyzeContext,
    role: SystemRole,
    selected: &[Seat],
    rest: &[Seat],
) -> bool {
    match role {
        SystemRole::Werehamster => test_hamster(env, ctx, selected, rest),
        SystemRole::Seer => test_seer(env, ctx, selected, rest),
        SystemRole::Medium => test_medium(env, ctx, selected, rest),
        SystemRole::Bodyguard => test_bodyguard(env, ctx, selected, rest),
        SystemRole::Mason => test_mason(env, ctx, selected, rest),
        SystemRole::Nekomata => test_nekomata(env, ctx, selected, rest),
        _ => true,
    }
}
