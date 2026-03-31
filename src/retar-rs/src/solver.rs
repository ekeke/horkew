use crate::types::{SystemRole, Seat};
use crate::possibilities::{
    Possibilities, ROLE_COUNT, pop_count, bit_indices_from_mask,
    combination_with_replacement_bit,
};
use std::collections::BTreeMap;

const WOLF_BIT: usize = SystemRole::Werewolf.bit_index_const() as usize;
const HAMSTER_BIT: usize = SystemRole::Werehamster.bit_index_const() as usize;

/// Item in the solver's work list.
#[derive(Debug, Clone)]
pub enum SolverItem {
    /// A group of seats sharing the same possibility bitmask.
    Group(u16, Vec<Seat>),
    /// Sentinel separating survivors from dead seats.
    Check,
}

/// Solver configuration — immutable across recursion.
struct SolverConfig {
    conclusion: Possibilities,
    items: Vec<SolverItem>,
    wolves_range: (u32, u32),   // (min, max) total wolves
    hamsters_range: (u32, u32), // (min, max) total hamsters
}

/// A path entry: (seats, role counts assigned to those seats).
type PathEntry = (Vec<Seat>, [u8; ROLE_COUNT]);

fn backtrack_for_role_assignment(
    config: &mut SolverConfig,
    role_count: &mut [u8; ROLE_COUNT],
    index: usize,
    selected_wolves: u32,
    selected_hamsters: u32,
    path: &mut Vec<PathEntry>,
    all: bool,
) -> bool {
    if index >= config.items.len() {
        return true;
    }

    match &config.items[index] {
        SolverItem::Check => {
            // Validate wolf/hamster counts at the survivor/dead boundary
            if config.wolves_range.1 < selected_wolves {
                return false;
            }
            if selected_wolves < config.wolves_range.0 {
                return false;
            }
            if config.hamsters_range.1 < selected_hamsters {
                return false;
            }
            if selected_hamsters < config.hamsters_range.0 {
                return false;
            }

            let mut role_count_copy = *role_count;
            let res = backtrack_for_role_assignment(
                config,
                &mut role_count_copy,
                index + 1,
                selected_wolves,
                selected_hamsters,
                &mut Vec::new(),
                false,
            );
            if !res {
                return false;
            }

            // Build bitmask of roles with remaining count > 0
            let mut filter_for_deads: u16 = 0;
            for i in 0..ROLE_COUNT {
                if role_count[i] > 0 {
                    filter_for_deads |= 1u16 << i;
                }
            }

            // Collect dead seat entries with filtered possibilities
            let mut dead_entries: Vec<(u16, Vec<Seat>)> = Vec::new();
            for i in (index + 1)..config.items.len() {
                if let SolverItem::Group(possibility, seats) = &config.items[i] {
                    dead_entries.push((possibility & filter_for_deads, seats.clone()));
                }
            }

            // Propagate constraints among dead seats
            let mut dead_role_count = *role_count;
            let mut changed = true;
            while changed {
                changed = false;

                // Naked singles: if a group has exactly one role and that role's count matches group size
                for idx in 0..dead_entries.len() {
                    let (poss, seats) = &dead_entries[idx];
                    if pop_count(*poss) == 1 {
                        let bit_idx = poss.trailing_zeros() as usize;
                        if dead_role_count[bit_idx] > 0
                            && dead_role_count[bit_idx] == seats.len() as u8
                        {
                            dead_role_count[bit_idx] = 0;
                            let mask = *poss;
                            for other_idx in 0..dead_entries.len() {
                                if other_idx == idx {
                                    continue;
                                }
                                let before = dead_entries[other_idx].0;
                                dead_entries[other_idx].0 = before & !mask;
                                if dead_entries[other_idx].0 != before {
                                    changed = true;
                                }
                            }
                        }
                    }
                }

                // Naked subset: groups whose possibilities ⊆ mask consume exactly those roles
                let mut checked = std::collections::BTreeSet::new();
                for idx in 0..dead_entries.len() {
                    let mask = dead_entries[idx].0;
                    if mask == 0 || checked.contains(&mask) {
                        continue;
                    }
                    checked.insert(mask);
                    let mut role_sum: u32 = 0;
                    for i in 0..ROLE_COUNT {
                        if mask & (1u16 << i) != 0 {
                            role_sum += dead_role_count[i] as u32;
                        }
                    }
                    if role_sum == 0 {
                        continue;
                    }
                    let mut seat_sum: u32 = 0;
                    for e in &dead_entries {
                        if e.0 != 0 && (e.0 & mask) == e.0 {
                            seat_sum += e.1.len() as u32;
                        }
                    }
                    if seat_sum == role_sum {
                        for e in &mut dead_entries {
                            if (e.0 & mask) == e.0 {
                                continue;
                            }
                            let before = e.0;
                            e.0 = before & !mask;
                            if e.0 != before {
                                changed = true;
                            }
                        }
                    }
                }

                // Role exhaustion: if a role's remaining count equals the total seats that need it
                for bit_idx in 0..ROLE_COUNT {
                    if dead_role_count[bit_idx] == 0 {
                        continue;
                    }
                    let role_bit = 1u16 << bit_idx;
                    let mut total_seats: u32 = 0;
                    let mut must_have_indices: Vec<usize> = Vec::new();
                    for (i, entry) in dead_entries.iter().enumerate() {
                        if entry.0 & role_bit != 0 {
                            total_seats += entry.1.len() as u32;
                            must_have_indices.push(i);
                        }
                    }
                    if total_seats == dead_role_count[bit_idx] as u32 {
                        for &i in &must_have_indices {
                            if dead_entries[i].0 != role_bit {
                                dead_entries[i].0 = role_bit;
                                changed = true;
                            }
                        }
                    }
                }
            }

            // Write dead seat results into conclusion
            for (possibility, seats) in &dead_entries {
                for &seat in seats {
                    config.conclusion.possibilities[seat as usize] |= possibility;
                }
            }

            // Write survivor path results into conclusion
            for (seats, counts) in path.iter() {
                for i in 0..ROLE_COUNT {
                    if counts[i] == 0 {
                        continue;
                    }
                    let bit = 1u16 << i;
                    for &seat in seats {
                        config.conclusion.possibilities[seat as usize] |= bit;
                    }
                }
            }

            true
        }
        SolverItem::Group(_, _) => {
            // Clone to avoid borrow issues
            let (set, seats) = match &config.items[index] {
                SolverItem::Group(s, seats) => (*s, seats.clone()),
                _ => unreachable!(),
            };

            // Last element optimization: check remaining role counts match seat count
            if index == config.items.len() - 1 {
                let mut count: u32 = 0;
                let mut sub: u16 = 0;
                for i in 0..ROLE_COUNT {
                    if role_count[i] > 0 {
                        count += role_count[i] as u32;
                        sub |= 1u16 << i;
                    }
                }
                if seats.len() as u32 != count {
                    return false;
                }
                if (set & sub) != sub {
                    return false;
                }
                return true;
            }

            let indices = bit_indices_from_mask(set);
            let mut one_ok = false;

            // Collect all combinations first (snapshot of limits), then process
            let limits_snapshot = *role_count;
            let mut combos: Vec<[u8; ROLE_COUNT]> = Vec::new();
            combination_with_replacement_bit(
                &indices,
                seats.len() as u32,
                &limits_snapshot,
                &mut |v| {
                    combos.push(*v);
                    true
                },
            );

            for v in &combos {
                let mut ok = true;
                for &idx in &indices {
                    let idx = idx as usize;
                    if v[idx] == 0 {
                        continue;
                    }
                    if role_count[idx] < v[idx] {
                        ok = false;
                    }
                    role_count[idx] -= v[idx];
                }
                path.push((seats.clone(), *v));
                if ok {
                    let res = backtrack_for_role_assignment(
                        config,
                        role_count,
                        index + 1,
                        selected_wolves + v[WOLF_BIT] as u32,
                        selected_hamsters + v[HAMSTER_BIT] as u32,
                        path,
                        all,
                    );
                    if res && !all {
                        for &idx in &indices {
                            let idx = idx as usize;
                            if v[idx] == 0 {
                                continue;
                            }
                            role_count[idx] += v[idx];
                        }
                        path.pop();
                        return true;
                    }
                    if res {
                        one_ok = true;
                    }
                }
                for &idx in &indices {
                    let idx = idx as usize;
                    if v[idx] == 0 {
                        continue;
                    }
                    role_count[idx] += v[idx];
                }
                path.pop();
            }
            one_ok
        }
    }
}

/// Solve possible role assignments for all seats.
///
/// Groups seats by their possibility bitmask (seats with identical possibilities
/// are tested together for efficiency). Fixed seats are processed first, then
/// survivors (full enumeration), then dead seats (satisfiability only).
///
/// Returns a Possibilities object with the union of all valid assignments,
/// or None if no valid assignment exists.
pub fn solve_possibilities(
    source: &Possibilities,
    survivors: &BTreeMap<Seat, bool>,
    min_surviving_wolves: u32,
    max_surviving_wolves: u32,
    min_surviving_hamsters: u32,
    max_surviving_hamsters: u32,
    setup: &BTreeMap<SystemRole, u32>,
) -> Option<Possibilities> {
    // Group seats by possibility bitmask, separated by survival status
    let mut survivors_map: BTreeMap<u16, Vec<Seat>> = BTreeMap::new();
    let mut dead_map: BTreeMap<u16, Vec<Seat>> = BTreeMap::new();
    let mut fixed_map: BTreeMap<u16, Vec<Seat>> = BTreeMap::new();
    let mut fixed_died_wolves: u32 = 0;
    let mut fixed_died_hamsters: u32 = 0;

    for i in 1..source.possibilities.len() {
        let possibility = source.possibilities[i];
        let count = pop_count(possibility);
        if count == 0 {
            return None;
        }
        let seat = i as Seat;
        if count == 1 {
            fixed_map.entry(possibility).or_default().push(seat);
            if possibility == SystemRole::Werewolf.bit()
                && !survivors.get(&seat).copied().unwrap_or(false)
            {
                fixed_died_wolves += 1;
            }
            if possibility == SystemRole::Werehamster.bit()
                && !survivors.get(&seat).copied().unwrap_or(false)
            {
                fixed_died_hamsters += 1;
            }
            continue;
        }
        if survivors.get(&seat).copied().unwrap_or(false) {
            survivors_map.entry(possibility).or_default().push(seat);
        } else {
            dead_map.entry(possibility).or_default().push(seat);
        }
    }

    // Build items array: fixed, survivors, check, dead
    let mut items: Vec<SolverItem> = Vec::new();
    for (poss, seats) in &fixed_map {
        items.push(SolverItem::Group(*poss, seats.clone()));
    }
    for (poss, seats) in &survivors_map {
        items.push(SolverItem::Group(*poss, seats.clone()));
    }
    items.push(SolverItem::Check);
    if !dead_map.is_empty() {
        for (poss, seats) in &dead_map {
            items.push(SolverItem::Group(*poss, seats.clone()));
        }
    }

    let mut config = SolverConfig {
        conclusion: Possibilities::empty(setup),
        items,
        wolves_range: (
            fixed_died_wolves.saturating_add(min_surviving_wolves),
            fixed_died_wolves.saturating_add(max_surviving_wolves),
        ),
        hamsters_range: (
            fixed_died_hamsters.saturating_add(min_surviving_hamsters),
            fixed_died_hamsters.saturating_add(max_surviving_hamsters),
        ),
    };

    // Build initial role count
    let mut role_count = [0u8; ROLE_COUNT];
    for (&role, &count) in setup {
        role_count[role.bit_index() as usize] = count as u8;
    }

    let res = backtrack_for_role_assignment(
        &mut config,
        &mut role_count,
        0,
        0,
        0,
        &mut Vec::new(),
        true,
    );

    if !res {
        #[cfg(feature = "dump")] crate::dump::solve_result(None);
        return None;
    }
    #[cfg(feature = "dump")] crate::dump::solve_result(Some(&config.conclusion));
    Some(config.conclusion)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_setup(pairs: &[(SystemRole, u32)]) -> BTreeMap<SystemRole, u32> {
        pairs.iter().cloned().collect()
    }

    #[test]
    fn solve_simple_fully_fixed() {
        // 4 seats, 4 unique roles — should trivially solve
        let setup = make_setup(&[
            (SystemRole::Seer, 1),
            (SystemRole::Bodyguard, 1),
            (SystemRole::Werewolf, 1),
            (SystemRole::Possessed, 1),
        ]);
        let mut p = Possibilities::from_setup(&setup);
        p.fix_role(1, SystemRole::Seer);
        p.fix_role(2, SystemRole::Bodyguard);
        p.fix_role(3, SystemRole::Werewolf);
        p.fix_role(4, SystemRole::Possessed);

        let survivors: BTreeMap<Seat, bool> =
            [(1, true), (2, true), (3, true), (4, true)].into_iter().collect();

        let result = solve_possibilities(&p, &survivors, 0, 2, 0, 0, &setup);
        assert!(result.is_some());
    }

    #[test]
    fn solve_with_unfixed_seats() {
        // 3 seats, seer/werewolf/villager — seat 1 dead (night kill)
        let setup = make_setup(&[
            (SystemRole::Seer, 1),
            (SystemRole::Werewolf, 1),
            (SystemRole::Villager, 1),
        ]);
        let p = Possibilities::from_setup(&setup);

        // seat 1 dead, seats 2,3 alive
        let survivors: BTreeMap<Seat, bool> =
            [(1, false), (2, true), (3, true)].into_iter().collect();

        let result = solve_possibilities(&p, &survivors, 1, 1, 0, 0, &setup);
        assert!(result.is_some());
        let conclusion = result.unwrap();

        // Seat 1 is dead, so it can be seer or villager (not wolf since wolf must be alive)
        // Actually, wolf must survive (min=max=1 surviving wolves), so seat 1 can't be wolf
        // Seats 2,3 must include 1 wolf
        assert!(conclusion.has_role(2, SystemRole::Werewolf) || conclusion.has_role(3, SystemRole::Werewolf));
    }

    #[test]
    fn solve_returns_none_on_impossible() {
        // 2 seats, 2 wolves, but require 0 surviving wolves with all alive
        let setup = make_setup(&[(SystemRole::Werewolf, 2)]);
        let p = Possibilities::from_setup(&setup);
        let survivors: BTreeMap<Seat, bool> =
            [(1, true), (2, true)].into_iter().collect();

        // min/max surviving wolves = 0, but both seats are alive and must be wolves
        let result = solve_possibilities(&p, &survivors, 0, 0, 0, 0, &setup);
        assert!(result.is_none());
    }
}
