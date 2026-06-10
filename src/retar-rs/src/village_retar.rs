use crate::types::{
    AnalyzeOptions, CauseOfDeath, Day, EnumSpecies, Faction, RoleTrait, Seat, SystemRole,
    VillageResult, VillageStatus,
};
use crate::possibilities::Possibilities;
use crate::combinatorics::generate_combinations;
use crate::role_testers::{
    AnalyzeContext, RoleTesterEnv, DeathChronicle, SeatRole, ContextSnapshot,
    save_into, restore_context, test_role,
};
use crate::role_sets::{
    has_trait, powered_village_roles_in, roles_by_seer_result, roles_by_trait,
    single_role_by_predicate,
};
use crate::plan_builder::{build_role_test_plan, RoleTest, RoleTestRole};
use crate::finalizer::{
    DebugStash, HamsterWinPath, update_death_count_constraints, finalize,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

// hot path で繰り返し参照するため module-level lazy 解決. TS index.ts:11-18 と同じ pattern.
static WOLF_ROLES: LazyLock<Vec<SystemRole>> = LazyLock::new(|| roles_by_seer_result(EnumSpecies::Wolf));
static FOX_ROLES: LazyLock<Vec<SystemRole>> = LazyLock::new(|| roles_by_trait(RoleTrait::PassiveDieWhenDivined));
static VILLAGER_ROLE: LazyLock<SystemRole> = LazyLock::new(|| {
    single_role_by_predicate(|r| r.faction() == Faction::Village && r.traits().is_empty())
});
// fixed_positions の確定先として使う集合. systemRoles 全体から取るので setup 非依存.
// 将来 同 trait を持つ役職が複数になったら、 fixed_positions に「集合のどれか」 を表現する
// 仕組みが必要 (現状は 1 役職前提で [0] を使う).
static NEKOMATA_ROLES: LazyLock<Vec<SystemRole>> = LazyLock::new(|| roles_by_trait(RoleTrait::ReactiveCurseOnExecuted));
static IMMORALIST_ROLES: LazyLock<Vec<SystemRole>> = LazyLock::new(|| roles_by_trait(RoleTrait::ReactiveFollowFoxDeath));

pub struct AnalyzeResult {
    pub elapsed_ms: f64,
    pub batch: u32,
    pub id: u32,
    pub aborted: bool,
    pub error: Option<String>,
    pub result: BTreeMap<Seat, BTreeSet<SystemRole>>,
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
    setup: BTreeMap<SystemRole, u32>,
    options: AnalyzeOptions,

    initial_possibilities: Possibilities,
    conclusions: Possibilities,
    context: Option<AnalyzeContext>,

    total_liar_roles: u32,
    known_fake_claim_count: u32,

    last_hamster_must_die_at: Option<Day>,
    last_hamster_must_died_by: Option<CauseOfDeath>,
    night_kills_by_day: BTreeMap<Day, Vec<Seat>>,
    last_deaths: Vec<Seat>,
    hamster_win_path: Option<HamsterWinPath>,

    role_tests: Vec<Vec<RoleTest>>,
    strides: Vec<i64>,
    snapshot_pool: Vec<ContextSnapshot>,

    cached_survivors: Vec<Seat>,
    cached_surviving_map: BTreeMap<Seat, bool>,

    pub debug_stash: DebugStash,
}

impl VillageRetar {
    pub fn new(
        mut vs: VillageStatus,
        setup: BTreeMap<SystemRole, u32>,
        options: AnalyzeOptions,
    ) -> Self {
        let conclusions = Possibilities::empty(&setup);

        // Village由来メタデータ（possibilities非依存）
        let (last_hamster_must_die_at, last_hamster_must_died_by) =
            extract_hamster_death_info(&vs);

        let mut night_kills_by_day: BTreeMap<Day, Vec<Seat>> = BTreeMap::new();
        let first_kill = options.day_count_from - if options.has_first_ghost { 1 } else { 0 };
        for d in first_kill..vs.day {
            night_kills_by_day.insert(d, Vec::new());
        }
        // bridge が peace 文を vs.kills に空エントリで登録している day を取り込み.
        // vs.day < d (= 「平和」 で day が増えた後の最終 peace day) のケースをカバー.
        for (&d, seats) in &vs.kills {
            if seats.is_empty() && !night_kills_by_day.contains_key(&d) {
                night_kills_by_day.insert(d, Vec::new());
            }
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
        let initial_possibilities = if let Some(prior) = options.prior.clone() {
            init_from_prior(&mut vs, &prior, &setup, &options, &night_kills_by_day, &last_deaths)
        } else {
            init_from_scratch(&mut vs, &setup, &options, &night_kills_by_day, &last_deaths)
        };

        // 共通後処理
        let plan = build_role_test_plan(&vs, &setup, &multiple_victims, Some(&initial_possibilities), Some(&options.hocus_pocus));
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
        let cached_surviving_map: BTreeMap<Seat, bool> =
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
            snapshot_pool: Vec::new(),
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
        #[cfg(feature = "dump")] crate::dump::analyze_result(&self.conclusions);

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
            .filter(|&&seat| WOLF_ROLES.iter().any(|&r| poss1.has_role(seat, r)))
            .cloned()
            .collect();
        if wolf_candidates.len() == 1 {
            path1_valid = poss1.fix_role(wolf_candidates[0], WOLF_ROLES[0]);
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
                // 確定席が狼/狐なら飽和パスの前提と矛盾 → 無効
                if WOLF_ROLES.iter().any(|&r| poss2.has_role(seat, r))
                    || FOX_ROLES.iter().any(|&r| poss2.has_role(seat, r))
                {
                    path2_valid = false;
                    break;
                }
                continue;
            }
            let mut wolf_denied = true;
            for &r in &*WOLF_ROLES {
                if !poss2.deny_role(seat, r) {
                    wolf_denied = false;
                    break;
                }
            }
            if !wolf_denied {
                path2_valid = false;
                break;
            }
            let mut fox_denied = true;
            for &r in &*FOX_ROLES {
                if !poss2.deny_role(seat, r) {
                    fox_denied = false;
                    break;
                }
            }
            if !fox_denied {
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
        let poss_len = self.initial_possibilities.possibilities.len();
        self.context = Some(AnalyzeContext {
            hamsters_killed_by_divine: Vec::new(),
            require_one_of: Vec::new(),
            death_chronicle: DeathChronicle::new(max_day),
            possibilities: self.initial_possibilities.clone_instance(),
            hamsters_max_surviving_day: i32::MAX,
            need_divine_alive_at_day: None,
            divine_alive_max_day: i32::MIN,
            divine_targets_by_day: std::collections::BTreeMap::new(),
        });
        // Pre-allocate snapshot pool: one per recursion depth + one for try_finalize
        let pool_size = self.role_tests.len() + 1;
        if self.snapshot_pool.len() < pool_size {
            self.snapshot_pool.clear();
            for _ in 0..pool_size {
                self.snapshot_pool.push(ContextSnapshot::new_empty(poss_len, max_day));
            }
        }
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

            save_into(&mut self.snapshot_pool[depth], self.context.as_ref().unwrap());
            let result = self.do_test_role(&test);

            if result {
                self.walk_role_tests(depth + 1, my_index);
            }

            restore_context(self.context.as_mut().unwrap(), &self.snapshot_pool[depth]);
        }
    }

    fn do_test_role(&mut self, scenario: &RoleTest) -> bool {
        match scenario.role {
            RoleTestRole::AllPass => true,
            RoleTestRole::Role(role) => {
                self.debug_stash.role_tests[role.bit_index() as usize] += 1;

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
                    self.debug_stash.role_test_passes[role.bit_index() as usize] += 1;
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
        if !update_death_count_constraints(ctx, &self.vs, &self.night_kills_by_day, &self.setup) {
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
            let a_can = WOLF_ROLES.iter().any(|&r| ctx.possibilities.has_role(seat_a, r));
            let b_can = WOLF_ROLES.iter().any(|&r| ctx.possibilities.has_role(seat_b, r));
            if !a_can || !b_can {
                continue;
            }
            deny_one_of.push(vec![
                SeatRole { seat: seat_a, role: WOLF_ROLES[0] },
                SeatRole { seat: seat_b, role: WOLF_ROLES[0] },
            ]);
        }

        let ctx = self.context.as_ref().unwrap();
        let require_one_of = ctx.require_one_of.clone();

        if !require_one_of.is_empty() || !deny_one_of.is_empty() {
            let finalize_slot = self.role_tests.len();
            save_into(&mut self.snapshot_pool[finalize_slot], self.context.as_ref().unwrap());

            let apply_deny_and_finalize = |slf: &mut VillageRetar, fix_var: &[SeatRole], deny_var: &[SeatRole]| {
                restore_context(slf.context.as_mut().unwrap(), &slf.snapshot_pool[finalize_slot]);

                let ctx = slf.context.as_mut().unwrap();
                for sr in fix_var {
                    if !ctx.possibilities.fix_role(sr.seat, sr.role) {
                        return;
                    }
                }
                let ctx = slf.context.as_mut().unwrap();
                for sr in deny_var {
                    ctx.possibilities.deny_role(sr.seat, sr.role);
                    if !ctx.possibilities.fix(sr.seat) {
                        return;
                    }
                }
                slf.do_finalize();
            };

            if !require_one_of.is_empty() && !deny_one_of.is_empty() {
                generate_combinations(&require_one_of, &mut |fix_var| {
                    generate_combinations(&deny_one_of, &mut |deny_var| {
                        apply_deny_and_finalize(self, fix_var, deny_var);
                    });
                });
            } else if !require_one_of.is_empty() {
                generate_combinations(&require_one_of, &mut |fix_var| {
                    apply_deny_and_finalize(self, fix_var, &[]);
                });
            } else {
                generate_combinations(&deny_one_of, &mut |deny_var| {
                    apply_deny_and_finalize(self, &[], deny_var);
                });
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
fn apply_hocus_pocus(vs: &mut VillageStatus, options: &AnalyzeOptions) {
    for (&seat, _) in &options.hocus_pocus {
        if let Some(status) = vs.statuses.get_mut(&seat) {
            status.assertions.clear();
            status.claiming = false;
            status.claiming_role = String::new();
            status.actions.clear();
        }
    }
}

fn apply_fixed_positions(
    vs: &VillageStatus,
    setup: &BTreeMap<SystemRole, u32>,
    options: &AnalyzeOptions,
    initial_possibilities: &mut Possibilities,
) {
    // 処刑道連れが発生した日を事前収集（処刑者が猫又の可能性を残すため）
    let mut curse_days: BTreeSet<Day> = BTreeSet::new();
    for status in vs.statuses.values() {
        if status.cause_of_death == CauseOfDeath::CursedByExecutedNekomata {
            if let Some(d) = status.died_day {
                curse_days.insert(d);
            }
        }
    }

    let villager_name = VILLAGER_ROLE.to_string();
    let powered_village = powered_village_roles_in(setup);

    let mut fixed_positions: BTreeMap<Seat, SystemRole> = BTreeMap::new();

    for (&seat, status) in vs.statuses.iter() {
        if status.claiming && status.claiming_role == villager_name {
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
                // 道連れ発生 → 道連れ役職 (猫又) の可能性を残し、他の能力持ち村役職を deny
                for &role in &powered_village {
                    if has_trait(role, RoleTrait::ReactiveCurseOnExecuted) {
                        continue;
                    }
                    initial_possibilities.deny_role(seat, role);
                }
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
        if fixed_positions.get(&seat_a) == Some(&WOLF_ROLES[0]) {
            for &r in &*WOLF_ROLES {
                initial_possibilities.deny_role(seat_b, r);
            }
        }
        if fixed_positions.get(&seat_b) == Some(&WOLF_ROLES[0]) {
            for &r in &*WOLF_ROLES {
                initial_possibilities.deny_role(seat_a, r);
            }
        }
    }

    // Special death causes
    for (&seat, status) in vs.statuses.iter() {
        if !status.surviving {
            match status.cause_of_death {
                CauseOfDeath::CursedByKilledNekomata => {
                    fixed_positions.insert(seat, WOLF_ROLES[0]);
                }
                CauseOfDeath::CursedByExecutedNekomata => {
                    for (&neko_seat, neko_status) in vs.statuses.iter() {
                        if neko_status.surviving {
                            continue;
                        }
                        if neko_status.cause_of_death == CauseOfDeath::Execution
                            && status.died_day == neko_status.died_day
                        {
                            fixed_positions.insert(neko_seat, NEKOMATA_ROLES[0]);
                        }
                    }
                }
                CauseOfDeath::FollowExecutedHamster => {
                    fixed_positions.insert(seat, IMMORALIST_ROLES[0]);
                }
                CauseOfDeath::FollowKilledHamster => {
                    fixed_positions.insert(seat, IMMORALIST_ROLES[0]);
                }
                _ => {}
            }
        }
    }

    for (&seat, &role) in &fixed_positions {
        initial_possibilities.fix_role(seat, role);
    }
}

fn apply_single_night_kill_rule(
    night_kills_by_day: &BTreeMap<Day, Vec<Seat>>,
    initial_possibilities: &mut Possibilities,
) {
    for killed in night_kills_by_day.values() {
        if killed.len() == 1 {
            for &r in &*WOLF_ROLES {
                initial_possibilities.deny_role(killed[0], r);
            }
        }
    }
}

/// 現在の vs に役職スライド or 結果スライドが含まれているか検査する。
/// スライドは「過去 valid だった世界線が無効化される or 過去 invalid だった世界線が解禁される」
/// という非単調な変化を引き起こすため、prior の possibilities (= 過去前提で求めた役職集合の和) は
/// チェーンの起点として安全に使えない。
fn has_slides_in_vs(vs: &VillageStatus) -> bool {
    for status in vs.statuses.values() {
        if let Some(prev_claims) = &status.previous_claims {
            if !prev_claims.is_empty() {
                return true;
            }
        }
        if let Some(prev_assertions) = &status.previous_assertions {
            if !prev_assertions.is_empty() {
                return true;
            }
        }
    }
    false
}

fn init_from_scratch(
    vs: &mut VillageStatus,
    setup: &BTreeMap<SystemRole, u32>,
    options: &AnalyzeOptions,
    night_kills_by_day: &BTreeMap<Day, Vec<Seat>>,
    last_deaths: &[Seat],
) -> Possibilities {
    apply_hocus_pocus(vs, options);
    let mut initial_possibilities = Possibilities::from_setup(setup);
    apply_fixed_positions(vs, setup, options, &mut initial_possibilities);
    apply_single_night_kill_rule(night_kills_by_day, &mut initial_possibilities);
    apply_game_end_constraints(vs, last_deaths, &mut initial_possibilities);
    initial_possibilities
}

/// 事前計算済みpossibilitiesを基に、追加assumptionで再計算。
/// prior は過去の時点で取得した結果でも良く、その場合は現在の vs に追加で発生した
/// 制約 (新しい CO、CO無し処刑、特殊死因、単独夜死体、ゲーム終了制約 等) を
/// monotonic な narrowing として prior の上から AND で適用する。
///
/// 例外: vs にスライドが含まれている場合、prior は安全に使えない。
/// init_from_scratch にフォールバックして prior を破棄する (assumptions は維持)。
fn init_from_prior(
    vs: &mut VillageStatus,
    prior: &Possibilities,
    setup: &BTreeMap<SystemRole, u32>,
    options: &AnalyzeOptions,
    night_kills_by_day: &BTreeMap<Day, Vec<Seat>>,
    last_deaths: &[Seat],
) -> Possibilities {
    if has_slides_in_vs(vs) {
        let initial_possibilities = init_from_scratch(vs, setup, options, night_kills_by_day, last_deaths);
        // init_from_scratch 内の apply_fixed_positions は assumption の fix_role を silent に行うため、
        // 不整合があった場合に明示的にエラーを投げるための事後検査。
        for (&seat, &role) in &options.assumptions {
            if !initial_possibilities.has_role(seat, role) {
                panic!(
                    "Prior-based re-analysis (slide-fallback): seat {} cannot be {:?}",
                    seat, role
                );
            }
        }
        return initial_possibilities;
    }

    apply_hocus_pocus(vs, options);

    // TS と同じパターン: setup ベースでフルサイズ確保 → prior の bits を上書き。
    // prior の Vec 長は serializer 側で maxSeat+1 にトリミングされるため、
    // 空 prior (length=1) や短い prior でも OOB しないよう dest 側のサイズに揃える。
    let mut initial_possibilities = Possibilities::from_setup(setup);
    let copy_len = prior.possibilities.len().min(initial_possibilities.possibilities.len());
    initial_possibilities.possibilities[..copy_len]
        .copy_from_slice(&prior.possibilities[..copy_len]);

    // prior ビットマスクに合わせて setup カウントを同期し、確定席の伝播を実行
    initial_possibilities.refix();

    // apply_fixed_positions が assumption を fix_role する際は失敗が silent なので、
    // ここで prior に対する整合性を先に明示的に検査する
    for (&seat, &role) in &options.assumptions {
        if !initial_possibilities.has_role(seat, role) {
            panic!(
                "Prior-based re-analysis: seat {} cannot be {:?} (not in prior possibilities)",
                seat, role
            );
        }
    }

    // 現在の vs から得られる制約 (新しい日に発生した CO/処刑/特殊死因/assumption/wolf_pair_denyals) を
    // prior の possibilities に追加適用する。prior が古い時点のものでも、進んだ日の制約を取りこぼさない。
    apply_fixed_positions(vs, setup, options, &mut initial_possibilities);
    apply_single_night_kill_rule(night_kills_by_day, &mut initial_possibilities);
    apply_game_end_constraints(vs, last_deaths, &mut initial_possibilities);

    // 全制約適用後、assumption が依然成立しているか検査 (特殊死因と矛盾するケース等を捕捉)
    for (&seat, &role) in &options.assumptions {
        if !initial_possibilities.has_role(seat, role) {
            panic!(
                "Prior-based re-analysis: fix_role({}, {:?}) caused contradiction",
                seat, role
            );
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
            .filter(|&&seat| WOLF_ROLES.iter().any(|&r| initial_possibilities.has_role(seat, r)))
            .cloned()
            .collect();
        if wolf_candidates.len() == 1 {
            initial_possibilities.fix_role(wolf_candidates[0], WOLF_ROLES[0]);
        }
    } else if vs.result == Some(VillageResult::WerewolfWon) {
        let has_confirmed_human = last_deaths.iter().any(|&seat| {
            let is_wolf_or_hamster = WOLF_ROLES.iter().any(|&r| initial_possibilities.has_role(seat, r))
                || FOX_ROLES.iter().any(|&r| initial_possibilities.has_role(seat, r));
            !is_wolf_or_hamster
        });
        if !has_confirmed_human {
            let unfixed: Vec<Seat> = last_deaths
                .iter()
                .filter(|&&seat| !initial_possibilities.is_fixed(seat))
                .cloned()
                .collect();
            if unfixed.len() == 1 {
                for &r in &*WOLF_ROLES {
                    initial_possibilities.deny_role(unfixed[0], r);
                }
                for &r in &*FOX_ROLES {
                    initial_possibilities.deny_role(unfixed[0], r);
                }
            }
        }
    }
}
