use crate::types::{CauseOfDeath, VillageStatus, VillageResult, SystemRole, Seat, Day, AnalyzeOptions};
use crate::possibilities::Possibilities;
use crate::combinatorics::generate_combinations_collect;
use crate::role_testers::{
    AnalyzeContext, RoleTesterEnv, DeathChronicle, SeatRole,
    save_context, restore_context, test_role,
};
use crate::plan_builder::{build_role_test_plan, RoleTest, RoleTestRole};
use crate::finalizer::{
    DebugStash, HamsterWinPath, constrain_by_death_counts_mut, finalize,
};
use std::collections::{HashMap, HashSet};

pub struct AnalyzeResult {
    pub elapsed_ms: f64,
    pub batch: u32,
    pub id: u32,
    pub aborted: bool,
    pub error: Option<String>,
    pub result: HashMap<Seat, HashSet<SystemRole>>,
    pub max_surviving_nv: i32,
}

/// Check if a subtree rooted at `start` with `size` paths contains any path for `batch`
fn subtree_contains_batch(start: i64, size: i64, batches: i64, batch: i64) -> bool {
    if size >= batches {
        return true;
    }
    let offset = ((batch - start % batches) % batches + batches) % batches;
    offset < size
}

pub struct VillageRetar {
    vs: VillageStatus,
    setup: HashMap<SystemRole, u32>,
    options: AnalyzeOptions,

    initial_possibilities: Possibilities,
    conclusions: Possibilities,
    context: Option<AnalyzeContext>,

    total_liar_roles: u32,
    known_fake_claim_count: u32,

    last_hamster_must_die_at: Option<Day>,
    last_hamster_must_died_by: Option<CauseOfDeath>,
    night_kills_by_day: HashMap<Day, Vec<Seat>>,
    last_deaths: Vec<Seat>,
    hamster_win_path: Option<HamsterWinPath>,

    role_tests: Vec<Vec<RoleTest>>,
    strides: Vec<i64>,

    cached_survivors: Vec<Seat>,
    cached_surviving_map: HashMap<Seat, bool>,

    pub debug_stash: DebugStash,
}

impl VillageRetar {
    pub fn new(
        mut vs: VillageStatus,
        setup: HashMap<SystemRole, u32>,
        options: AnalyzeOptions,
    ) -> Self {
        let conclusions = Possibilities::empty(&setup);

        // Village由来メタデータ（possibilities非依存）
        let (last_hamster_must_die_at, last_hamster_must_died_by) =
            extract_hamster_death_info(&vs);

        let mut night_kills_by_day: HashMap<Day, Vec<Seat>> = HashMap::new();
        let first_kill = options.day_count_from - if options.has_first_ghost { 1 } else { 0 };
        for d in first_kill..vs.day {
            night_kills_by_day.insert(d, Vec::new());
        }
        for (&seat, status) in &vs.statuses {
            if status.surviving {
                continue;
            }
            if status.cause_of_death == CauseOfDeath::NightKill
                || status.cause_of_death == CauseOfDeath::CursedByKilledNekomata
            {
                if let Some(died_day) = status.died_day {
                    night_kills_by_day
                        .entry(died_day)
                        .or_default()
                        .push(seat);
                }
            }
        }

        let multiple_victims: Vec<Seat> = night_kills_by_day
            .values()
            .filter(|v| v.len() > 1)
            .flatten()
            .cloned()
            .collect();

        let last_deaths = find_last_deaths(&vs);

        // 初期化分岐
        let initial_possibilities = if let Some(ref prior) = options.prior {
            init_from_prior(prior, &options)
        } else {
            init_from_scratch(&mut vs, &setup, &options, &night_kills_by_day, &last_deaths)
        };

        // 共通後処理
        let plan = build_role_test_plan(&vs, &setup, &multiple_victims, Some(&initial_possibilities));
        let role_tests = plan.role_tests;
        let total_liar_roles = plan.total_liar_roles;
        let known_fake_claim_count = plan.known_fake_claim_count;

        // Compute strides
        let mut strides = vec![0i64; role_tests.len()];
        if !role_tests.is_empty() {
            strides[role_tests.len() - 1] = 1;
            for d in (0..role_tests.len() - 1).rev() {
                strides[d] = strides[d + 1] * role_tests[d + 1].len() as i64;
            }
        }

        // Cached survivors
        let cached_survivors: Vec<Seat> = vs
            .statuses
            .iter()
            .filter(|(_, s)| s.surviving)
            .map(|(&seat, _)| seat)
            .collect();
        let cached_surviving_map: HashMap<Seat, bool> =
            cached_survivors.iter().map(|&s| (s, true)).collect();

        VillageRetar {
            vs,
            setup,
            options,
            initial_possibilities,
            conclusions,
            context: None,
            total_liar_roles,
            known_fake_claim_count,
            last_hamster_must_die_at,
            last_hamster_must_died_by,
            night_kills_by_day,
            last_deaths,
            hamster_win_path: None,
            role_tests,
            strides,
            cached_survivors,
            cached_surviving_map,
            debug_stash: DebugStash::default(),
        }
    }

    pub fn initial_possibilities(&self) -> &Possibilities {
        &self.initial_possibilities
    }

    fn compute_alive_mask(&self) -> u32 {
        let mut alive: u32 = 0;
        for &seat in &self.cached_survivors {
            alive |= 1u32 << seat;
        }
        alive
    }

    pub fn analyze(&mut self) -> AnalyzeResult {
        if self.vs.result == Some(VillageResult::WerehamsterWon) && !self.last_deaths.is_empty() {
            return self.analyze_hamster_win();
        }

        self.run_analysis();
        self.conclusions.compute_max_surviving_nv(self.compute_alive_mask());

        AnalyzeResult {
            elapsed_ms: 0.0, // timing done by caller
            batch: self.options.batch,
            id: self.options.id,
            aborted: false,
            error: None,
            result: self.conclusions.to_structured(),
            max_surviving_nv: self.conclusions.max_surviving_nv,
        }
    }

    fn analyze_hamster_win(&mut self) -> AnalyzeResult {
        let original_possibilities = self.initial_possibilities.clone_instance();

        // Path 1: wolves eliminated (village-like)
        self.hamster_win_path = Some(HamsterWinPath::Village);
        let mut poss1 = original_possibilities.clone_instance();
        let mut path1_valid = true;
        let wolf_candidates: Vec<Seat> = self
            .last_deaths
            .iter()
            .filter(|&&seat| poss1.has_role(seat, SystemRole::Werewolf))
            .cloned()
            .collect();
        if wolf_candidates.len() == 1 {
            path1_valid = poss1.fix_role(wolf_candidates[0], SystemRole::Werewolf);
        } else if wolf_candidates.is_empty() {
            path1_valid = false;
        }
        if path1_valid {
            self.initial_possibilities = poss1;
            self.run_analysis();
        }

        // Path 2: saturation (wolf-like)
        self.hamster_win_path = Some(HamsterWinPath::Wolf);
        let mut poss2 = original_possibilities.clone_instance();
        let mut path2_valid = true;
        for &seat in &self.last_deaths {
            if poss2.is_fixed(seat) {
                continue;
            }
            if !poss2.deny_role(seat, SystemRole::Werewolf) {
                path2_valid = false;
                break;
            }
            if !poss2.deny_role(seat, SystemRole::Werehamster) {
                path2_valid = false;
                break;
            }
        }
        if path2_valid {
            self.initial_possibilities = poss2;
            self.run_analysis();
        }

        // Restore
        self.initial_possibilities = original_possibilities;
        self.hamster_win_path = None;

        self.conclusions.compute_max_surviving_nv(self.compute_alive_mask());

        AnalyzeResult {
            elapsed_ms: 0.0,
            batch: self.options.batch,
            id: self.options.id,
            aborted: false,
            error: None,
            result: self.conclusions.to_structured(),
            max_surviving_nv: self.conclusions.max_surviving_nv,
        }
    }

    fn run_analysis(&mut self) {
        let max_day = (self.vs.day + 1) as usize;
        self.context = Some(AnalyzeContext {
            hamsters_killed_by_seer: Vec::new(),
            require_one_of: Vec::new(),
            death_chronicle: DeathChronicle::new(max_day),
            possibilities: self.initial_possibilities.clone_instance(),
            hamsters_max_surviving_day: i32::MAX,
            need_seer_at_day: None,
        });
        self.walk_role_tests(0, 0);
    }

    fn walk_role_tests(&mut self, depth: usize, base_index: i64) {
        if depth >= self.role_tests.len() {
            self.try_finalize();
            return;
        }

        let group_len = self.role_tests[depth].len();
        let stride = self.strides[depth];
        let batches = self.options.batches as i64;
        let batch = self.options.batch as i64;

        for i in 0..group_len {
            if self.is_saturated() {
                return;
            }

            let my_index = base_index + i as i64 * stride;
            if batches > 1 && !subtree_contains_batch(my_index, stride, batches, batch) {
                continue;
            }

            let test = self.role_tests[depth][i].clone();

            // Pre-check: can selected seats hold this role?
            if test.role != RoleTestRole::AllPass {
                if let RoleTestRole::Role(role) = test.role {
                    let ctx = self.context.as_ref().unwrap();
                    let skip = test
                        .selected
                        .iter()
                        .any(|&seat| !ctx.possibilities.has_role(seat, role));
                    if skip {
                        continue;
                    }
                }
            }

            let snapshot = save_context(self.context.as_ref().unwrap());
            let result = self.do_test_role(&test);

            if result {
                self.walk_role_tests(depth + 1, my_index);
            }

            restore_context(self.context.as_mut().unwrap(), &snapshot);
        }
    }

    fn do_test_role(&mut self, scenario: &RoleTest) -> bool {
        match scenario.role {
            RoleTestRole::AllPass => true,
            RoleTestRole::Role(role) => {
                // Update debug stash
                match role {
                    SystemRole::Seer => self.debug_stash.seer_tests += 1,
                    SystemRole::Medium => self.debug_stash.medium_tests += 1,
                    SystemRole::Bodyguard => self.debug_stash.bodyguard_tests += 1,
                    SystemRole::Mason => self.debug_stash.mason_tests += 1,
                    SystemRole::Nekomata => self.debug_stash.nekomata_tests += 1,
                    SystemRole::Werehamster => self.debug_stash.werehamster_tests += 1,
                    _ => {}
                }

                let env = RoleTesterEnv {
                    vs: &self.vs,
                    night_kills_by_day: &self.night_kills_by_day,
                    total_liar_roles: self.total_liar_roles,
                    known_fake_claim_count: self.known_fake_claim_count,
                    last_hamster_must_die_at: self.last_hamster_must_die_at,
                    last_hamster_must_died_by: self.last_hamster_must_died_by,
                    day_count_from: self.options.day_count_from,
                };

                let ctx = self.context.as_mut().unwrap();
                let result = test_role(&env, ctx, role, &scenario.selected, &scenario.rest);

                if result {
                    match role {
                        SystemRole::Seer => self.debug_stash.seer_test_passes += 1,
                        SystemRole::Medium => self.debug_stash.medium_test_passes += 1,
                        SystemRole::Bodyguard => self.debug_stash.bodyguard_test_passes += 1,
                        SystemRole::Mason => self.debug_stash.mason_test_passes += 1,
                        SystemRole::Nekomata => self.debug_stash.nekomata_test_passes += 1,
                        SystemRole::Werehamster => self.debug_stash.werehamster_test_passes += 1,
                        _ => {}
                    }
                }
                result
            }
        }
    }

    fn is_saturated(&self) -> bool {
        for i in 1..self.initial_possibilities.possibilities.len() {
            let initial = self.initial_possibilities.possibilities[i];
            if (self.conclusions.possibilities[i] & initial) != initial {
                return false;
            }
        }
        true
    }

    fn try_finalize(&mut self) {
        if self.is_saturated() {
            return;
        }
        self.debug_stash.pre_finalize_tests += 1;

        // Death count validation
        let ctx = self.context.as_mut().unwrap();
        if !constrain_by_death_counts_mut(ctx, &self.vs, &self.night_kills_by_day, &self.setup) {
            return;
        }

        // Liar count check
        if self.total_liar_roles <= self.known_fake_claim_count {
            let seats: Vec<Seat> = self.vs.statuses.keys().cloned().collect();
            for seat in seats {
                let ctx = self.context.as_mut().unwrap();
                if ctx.possibilities.is_fixed(seat) {
                    continue;
                }
                let status = self.vs.statuses.get(&seat).unwrap();
                if !status.claiming || status.claiming_role == "villager" {
                    ctx.possibilities.mark_as_not_liar(seat);
                }
            }
        }
        self.debug_stash.pre_finalize_passes += 1;

        // Wolf pair denials → denyOneOf groups
        let ctx = self.context.as_ref().unwrap();
        let mut deny_one_of: Vec<Vec<SeatRole>> = Vec::new();
        for &(seat_a, seat_b) in &self.options.wolf_pair_denyals {
            let a_can = ctx.possibilities.has_role(seat_a, SystemRole::Werewolf);
            let b_can = ctx.possibilities.has_role(seat_b, SystemRole::Werewolf);
            if !a_can || !b_can {
                continue;
            }
            deny_one_of.push(vec![
                SeatRole { seat: seat_a, role: SystemRole::Werewolf },
                SeatRole { seat: seat_b, role: SystemRole::Werewolf },
            ]);
        }

        let ctx = self.context.as_ref().unwrap();
        let require_one_of = ctx.require_one_of.clone();

        if !require_one_of.is_empty() || !deny_one_of.is_empty() {
            let snapshot = save_context(self.context.as_ref().unwrap());

            // Generate all fix/deny variations
            let fix_variations = if !require_one_of.is_empty() {
                generate_combinations_collect(&require_one_of)
            } else {
                vec![Vec::new()]
            };
            let deny_variations = if !deny_one_of.is_empty() {
                generate_combinations_collect(&deny_one_of)
            } else {
                vec![Vec::new()]
            };

            for fix_var in &fix_variations {
                for deny_var in &deny_variations {
                    restore_context(self.context.as_mut().unwrap(), &snapshot);

                    let mut ok = true;
                    let ctx = self.context.as_mut().unwrap();
                    for sr in fix_var {
                        if !ctx.possibilities.fix_role(sr.seat, sr.role) {
                            ok = false;
                            break;
                        }
                    }
                    if !ok {
                        continue;
                    }
                    let ctx = self.context.as_mut().unwrap();
                    for sr in deny_var {
                        ctx.possibilities.deny_role(sr.seat, sr.role);
                        if !ctx.possibilities.fix(sr.seat) {
                            ok = false;
                            break;
                        }
                    }
                    if !ok {
                        continue;
                    }
                    self.do_finalize();
                }
            }
        } else {
            self.do_finalize();
        }
    }

    fn do_finalize(&mut self) {
        let ctx = self.context.as_mut().unwrap();
        finalize(
            ctx,
            &self.vs,
            &self.setup,
            &mut self.conclusions,
            &mut self.debug_stash,
            self.hamster_win_path,
            &self.cached_survivors,
            &self.cached_surviving_map,
        );
    }
}

/// 後追い死亡によるハムスター死亡情報の抽出（possibilities非依存）
fn extract_hamster_death_info(vs: &VillageStatus) -> (Option<Day>, Option<CauseOfDeath>) {
    let mut last_hamster_must_die_at: Option<Day> = None;
    let mut last_hamster_must_died_by: Option<CauseOfDeath> = None;
    for status in vs.statuses.values() {
        if !status.surviving {
            match status.cause_of_death {
                CauseOfDeath::FollowExecutedHamster => {
                    last_hamster_must_die_at = status.died_day;
                    last_hamster_must_died_by = Some(CauseOfDeath::Execution);
                }
                CauseOfDeath::FollowKilledHamster => {
                    last_hamster_must_die_at = status.died_day;
                    last_hamster_must_died_by = Some(CauseOfDeath::NightKill);
                }
                _ => {}
            }
        }
    }
    (last_hamster_must_die_at, last_hamster_must_died_by)
}

/// ゼロから初期化（従来のフルパス）
fn init_from_scratch(
    vs: &mut VillageStatus,
    setup: &HashMap<SystemRole, u32>,
    options: &AnalyzeOptions,
    night_kills_by_day: &HashMap<Day, Vec<Seat>>,
    last_deaths: &[Seat],
) -> Possibilities {
    // Apply hocus pocus
    for (&seat, _) in &options.hocus_pocus {
        if let Some(status) = vs.statuses.get_mut(&seat) {
            status.assertions.clear();
            status.claiming = false;
            status.claiming_role = String::new();
            status.actions.clear();
        }
    }

    let mut initial_possibilities = Possibilities::from_setup(setup);

    // 処刑道連れが発生した日を事前収集（処刑者が猫又の可能性を残すため）
    let mut curse_days: HashSet<Day> = HashSet::new();
    for status in vs.statuses.values() {
        if status.cause_of_death == CauseOfDeath::CursedByExecutedNekomata {
            if let Some(d) = status.died_day {
                curse_days.insert(d);
            }
        }
    }

    // Apply fixed positions
    let mut fixed_positions: HashMap<Seat, SystemRole> = HashMap::new();

    for (&seat, status) in vs.statuses.iter() {
        if status.claiming && status.claiming_role == "villager" {
            initial_possibilities.mark_as_no_village_role(seat);
        }
        if status.claiming && status.claiming_role == "surrender" {
            initial_possibilities.mark_as_liar(seat);
        }
        if !status.claiming
            && !status.surviving
            && status.cause_of_death == CauseOfDeath::Execution
            && !status.no_co_opportunity.unwrap_or(false)
        {
            if status.died_day.map_or(false, |d| curse_days.contains(&d)) {
                // 道連れ発生 → 猫又の可能性を残し、他の村役職のみdeny
                initial_possibilities.deny_role(seat, SystemRole::Seer);
                initial_possibilities.deny_role(seat, SystemRole::Medium);
                initial_possibilities.deny_role(seat, SystemRole::Bodyguard);
                initial_possibilities.deny_role(seat, SystemRole::Mason);
            } else {
                initial_possibilities.mark_as_no_village_role(seat);
            }
        }
        for &role in &status.denied_roles {
            initial_possibilities.deny_role(seat, role);
        }
    }

    // Assumptions
    for (&seat, &role) in &options.assumptions {
        fixed_positions.insert(seat, role);
    }

    // Wolf pair denial early application
    for &(seat_a, seat_b) in &options.wolf_pair_denyals {
        if fixed_positions.get(&seat_a) == Some(&SystemRole::Werewolf) {
            initial_possibilities.deny_role(seat_b, SystemRole::Werewolf);
        }
        if fixed_positions.get(&seat_b) == Some(&SystemRole::Werewolf) {
            initial_possibilities.deny_role(seat_a, SystemRole::Werewolf);
        }
    }

    // Special death causes
    for (&seat, status) in vs.statuses.iter() {
        if !status.surviving {
            match status.cause_of_death {
                CauseOfDeath::CursedByKilledNekomata => {
                    fixed_positions.insert(seat, SystemRole::Werewolf);
                }
                CauseOfDeath::CursedByExecutedNekomata => {
                    for (&neko_seat, neko_status) in vs.statuses.iter() {
                        if neko_status.surviving {
                            continue;
                        }
                        if neko_status.cause_of_death == CauseOfDeath::Execution
                            && status.died_day == neko_status.died_day
                        {
                            fixed_positions.insert(neko_seat, SystemRole::Nekomata);
                        }
                    }
                }
                CauseOfDeath::FollowExecutedHamster => {
                    fixed_positions.insert(seat, SystemRole::Immoralist);
                }
                CauseOfDeath::FollowKilledHamster => {
                    fixed_positions.insert(seat, SystemRole::Immoralist);
                }
                _ => {}
            }
        }
    }

    for (&seat, &role) in &fixed_positions {
        initial_possibilities.fix_role(seat, role);
    }

    // Single night kill victims can't be wolves
    for killed in night_kills_by_day.values() {
        if killed.len() == 1 {
            initial_possibilities.deny_role(killed[0], SystemRole::Werewolf);
        }
    }

    // Apply game end constraints
    apply_game_end_constraints(vs, last_deaths, &mut initial_possibilities);

    initial_possibilities
}

/// 事前計算済みpossibilitiesを基に、追加assumptionで再計算
fn init_from_prior(
    prior: &Possibilities,
    options: &AnalyzeOptions,
) -> Possibilities {
    let mut initial_possibilities = prior.clone();

    for (&seat, &role) in &options.assumptions {
        if !initial_possibilities.has_role(seat, role) {
            panic!(
                "Prior-based re-analysis: seat {} cannot be {:?} (not in prior possibilities)",
                seat, role
            );
        }
        if !initial_possibilities.fix_role(seat, role) {
            panic!(
                "Prior-based re-analysis: fix_role({}, {:?}) caused contradiction",
                seat, role
            );
        }
    }

    // 狼ペア否定の早期適用: 新assumptionで狼確定した場合
    for &(seat_a, seat_b) in &options.wolf_pair_denyals {
        if options.assumptions.get(&seat_a) == Some(&SystemRole::Werewolf) {
            initial_possibilities.deny_role(seat_b, SystemRole::Werewolf);
        }
        if options.assumptions.get(&seat_b) == Some(&SystemRole::Werewolf) {
            initial_possibilities.deny_role(seat_a, SystemRole::Werewolf);
        }
    }

    initial_possibilities
}

fn find_last_deaths(vs: &VillageStatus) -> Vec<Seat> {
    if !vs.finished || vs.result.is_none() {
        return Vec::new();
    }
    if vs.result == Some(VillageResult::Draw) {
        return Vec::new();
    }

    let mut max_died_day: Day = -1;
    for status in vs.statuses.values() {
        if !status.surviving {
            if let Some(d) = status.died_day {
                if d > max_died_day {
                    max_died_day = d;
                }
            }
        }
    }
    if max_died_day < 0 {
        return Vec::new();
    }

    let mut night_phase_deaths = Vec::new();
    let mut day_phase_deaths = Vec::new();
    for (&seat, status) in &vs.statuses {
        if !status.surviving && status.died_day == Some(max_died_day) {
            match status.cause_of_death {
                CauseOfDeath::NightKill
                | CauseOfDeath::CursedByKilledNekomata
                | CauseOfDeath::FollowKilledHamster => {
                    night_phase_deaths.push(seat);
                }
                _ => {
                    day_phase_deaths.push(seat);
                }
            }
        }
    }

    if !night_phase_deaths.is_empty() {
        night_phase_deaths
    } else {
        day_phase_deaths
    }
}

fn apply_game_end_constraints(
    vs: &VillageStatus,
    last_deaths: &[Seat],
    initial_possibilities: &mut Possibilities,
) {
    if last_deaths.is_empty() {
        return;
    }

    if vs.result == Some(VillageResult::VillagerWon) {
        let wolf_candidates: Vec<Seat> = last_deaths
            .iter()
            .filter(|&&seat| initial_possibilities.has_role(seat, SystemRole::Werewolf))
            .cloned()
            .collect();
        if wolf_candidates.len() == 1 {
            initial_possibilities.fix_role(wolf_candidates[0], SystemRole::Werewolf);
        }
    } else if vs.result == Some(VillageResult::WerewolfWon) {
        let has_confirmed_human = last_deaths.iter().any(|&seat| {
            let is_wolf_or_hamster = initial_possibilities.has_role(seat, SystemRole::Werewolf)
                || initial_possibilities.has_role(seat, SystemRole::Werehamster);
            !is_wolf_or_hamster
        });
        if !has_confirmed_human {
            let unfixed: Vec<Seat> = last_deaths
                .iter()
                .filter(|&&seat| !initial_possibilities.is_fixed(seat))
                .cloned()
                .collect();
            if unfixed.len() == 1 {
                initial_possibilities.deny_role(unfixed[0], SystemRole::Werewolf);
                initial_possibilities.deny_role(unfixed[0], SystemRole::Werehamster);
            }
        }
    }
}
