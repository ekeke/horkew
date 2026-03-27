use crate::types::{SystemRole, Seat};
use std::collections::{HashMap, HashSet};

pub const ROLE_COUNT: usize = 11;

// Composite bitmask constants
pub const ALL_ROLES: u16 = (1u16 << ROLE_COUNT) - 1; // 0b11111111111
pub const HUMAN: u16 = ALL_ROLES & !SystemRole::Werewolf.bit_const();
pub const VILLAGE_ROLES: u16 = SystemRole::Seer.bit_const()
    | SystemRole::Medium.bit_const()
    | SystemRole::Bodyguard.bit_const()
    | SystemRole::Mason.bit_const()
    | SystemRole::Nekomata.bit_const();
pub const LIAR: u16 = SystemRole::Werewolf.bit_const()
    | SystemRole::Possessed.bit_const()
    | SystemRole::Fanatic.bit_const()
    | SystemRole::Werehamster.bit_const()
    | SystemRole::Immoralist.bit_const();

// Extend SystemRole with const fn for use in const expressions
impl SystemRole {
    pub const fn bit_const(self) -> u16 {
        1u16 << self.bit_index_const()
    }

    pub const fn bit_index_const(self) -> u8 {
        match self {
            SystemRole::Villager => 0,
            SystemRole::Seer => 1,
            SystemRole::Medium => 2,
            SystemRole::Bodyguard => 3,
            SystemRole::Mason => 4,
            SystemRole::Nekomata => 5,
            SystemRole::Werewolf => 6,
            SystemRole::Possessed => 7,
            SystemRole::Fanatic => 8,
            SystemRole::Werehamster => 9,
            SystemRole::Immoralist => 10,
        }
    }
}

#[inline]
pub fn pop_count(x: u16) -> u32 {
    x.count_ones()
}

pub fn bit_indices_from_mask(mask: u16) -> Vec<u8> {
    let mut result = Vec::new();
    let mut m = mask;
    let mut i = 0u8;
    while m != 0 {
        if m & 1 != 0 {
            result.push(i);
        }
        m >>= 1;
        i += 1;
    }
    result
}

pub fn roles_from_possibility(bit: u16) -> Vec<SystemRole> {
    let mut result = Vec::new();
    for role in SystemRole::ALL {
        if bit & role.bit() != 0 {
            result.push(role);
        }
    }
    result
}

pub fn set_of_roles_from_possibility(possibility: u16) -> HashSet<SystemRole> {
    let mut result = HashSet::new();
    for role in SystemRole::ALL {
        if possibility & role.bit() != 0 {
            result.insert(role);
        }
    }
    result
}

pub fn possibility_from_roles(roles: &HashSet<SystemRole>) -> u16 {
    let mut result: u16 = 0;
    for &role in roles {
        result |= role.bit();
    }
    result
}

#[inline]
pub fn has_role_in_possibility(possibility: u16, role: SystemRole) -> bool {
    (possibility & role.bit()) != 0
}

#[inline]
pub fn remove_role_from_possibility(possibility: u16, role: SystemRole) -> u16 {
    possibility & !role.bit()
}

#[inline]
pub fn add_role_to_possibility(possibility: u16, role: SystemRole) -> u16 {
    possibility | role.bit()
}

#[derive(Debug, Clone)]
pub struct Possibilities {
    pub possibilities: Vec<u16>,
    pub setup: [u8; ROLE_COUNT],
    pub setup_original: [u8; ROLE_COUNT],
}

impl Possibilities {
    /// Create from a setup map (role → count). Initializes all seats with all roles present in setup.
    pub fn from_setup(setup: &HashMap<SystemRole, u32>) -> Self {
        let mut count: usize = 0;
        let mut initial: u16 = 0;
        let mut setup_arr = [0u8; ROLE_COUNT];
        for (&role, &num) in setup {
            setup_arr[role.bit_index() as usize] = num as u8;
            count += num as usize;
            initial |= role.bit();
        }
        let setup_original = setup_arr;
        let mut possibilities = vec![0u16; count + 1]; // index 0 unused
        for i in 1..=count {
            possibilities[i] = initial;
        }
        Possibilities {
            possibilities,
            setup: setup_arr,
            setup_original,
        }
    }

    /// Create empty (all zeros) with same dimensions as setup
    pub fn empty(setup: &HashMap<SystemRole, u32>) -> Self {
        let mut p = Self::from_setup(setup);
        for i in 0..p.possibilities.len() {
            p.possibilities[i] = 0;
        }
        p
    }

    /// Create with a given seat count (all zeros), empty setup
    pub fn with_seat_count(seat_count: usize) -> Self {
        Possibilities {
            possibilities: vec![0u16; seat_count + 1],
            setup: [0u8; ROLE_COUNT],
            setup_original: [0u8; ROLE_COUNT],
        }
    }

    pub fn seat_count(&self) -> usize {
        self.possibilities.len() - 1
    }

    pub fn clone_instance(&self) -> Self {
        Possibilities {
            possibilities: self.possibilities.clone(),
            setup: self.setup,
            setup_original: self.setup_original,
        }
    }

    pub fn get(&self, seat: Seat) -> u16 {
        self.possibilities[seat as usize]
    }

    pub fn set(&mut self, seat: Seat, possibility: u16) {
        self.possibilities[seat as usize] = possibility;
    }

    pub fn set_role(&mut self, seat: Seat, role: SystemRole) {
        self.possibilities[seat as usize] = role.bit();
    }

    pub fn is_fixed(&self, seat: Seat) -> bool {
        pop_count(self.possibilities[seat as usize]) == 1
    }

    pub fn has_role(&self, seat: Seat, role: SystemRole) -> bool {
        (self.possibilities[seat as usize] & role.bit()) != 0
    }

    pub fn is_actual_role(&self, seat: Seat, role: SystemRole) -> bool {
        self.possibilities[seat as usize] == role.bit()
    }

    pub fn fix_role(&mut self, seat: Seat, role: SystemRole) -> bool {
        let seat_idx = seat as usize;
        if self.possibilities[seat_idx] == role.bit() {
            return true;
        }
        if !self.has_role(seat, role) {
            return false;
        }
        self.possibilities[seat_idx] &= role.bit();
        self.fix(seat)
    }

    pub fn fix(&mut self, seat: Seat) -> bool {
        let seat_idx = seat as usize;
        let p = self.possibilities[seat_idx];
        let count = pop_count(p);
        if count == 0 {
            return false;
        }
        if count == 1 {
            let bit_idx = p.trailing_zeros() as usize;
            if self.setup[bit_idx] == 0 {
                return false;
            }
            if self.setup[bit_idx] == 1 {
                let the_role = p;
                for i in 1..self.possibilities.len() {
                    if i == seat_idx {
                        continue;
                    }
                    if self.possibilities[i] == the_role {
                        continue;
                    }
                    self.possibilities[i] &= !the_role;
                    if self.possibilities[i] == 0 {
                        return false;
                    }
                }
            }
            self.setup[bit_idx] -= 1;
        }
        true
    }

    pub fn refix(&mut self) -> bool {
        self.setup = self.setup_original;
        for i in 1..self.possibilities.len() {
            if !self.fix(i as Seat) {
                return false;
            }
        }
        true
    }

    pub fn deny_role(&mut self, seat: Seat, role: SystemRole) -> bool {
        let seat_idx = seat as usize;
        self.possibilities[seat_idx] &= !role.bit();
        self.possibilities[seat_idx] != 0
    }

    pub fn mark_as_liar(&mut self, seat: Seat) -> bool {
        let seat_idx = seat as usize;
        self.possibilities[seat_idx] &= LIAR;
        self.possibilities[seat_idx] != 0
    }

    pub fn mark_as_not_liar(&mut self, seat: Seat) -> bool {
        let seat_idx = seat as usize;
        self.possibilities[seat_idx] &= !LIAR;
        self.possibilities[seat_idx] != 0
    }

    pub fn mark_as_human(&mut self, seat: Seat) -> bool {
        let seat_idx = seat as usize;
        self.possibilities[seat_idx] &= HUMAN;
        self.possibilities[seat_idx] != 0
    }

    pub fn mark_as_no_village_role(&mut self, seat: Seat) -> bool {
        let seat_idx = seat as usize;
        self.possibilities[seat_idx] &= !VILLAGE_ROLES;
        self.possibilities[seat_idx] != 0
    }

    pub fn union(&mut self, other: &Possibilities) {
        for i in 1..self.possibilities.len() {
            self.possibilities[i] |= other.possibilities[i];
        }
    }

    pub fn get_possible_seats_for_role(&self, role: SystemRole) -> Vec<Seat> {
        let mut result = Vec::new();
        for i in 1..self.possibilities.len() {
            if self.has_role(i as Seat, role) {
                result.push(i as Seat);
            }
        }
        result
    }

    pub fn to_structured(&self) -> HashMap<Seat, HashSet<SystemRole>> {
        let mut result = HashMap::new();
        for i in 1..self.possibilities.len() {
            result.insert(i as Seat, set_of_roles_from_possibility(self.possibilities[i]));
        }
        result
    }
}

/// Generator-like combination with replacement within limits.
/// Calls `callback` for each valid combination. Callback receives a shared buffer.
/// Return `false` from callback to stop early.
pub fn combination_with_replacement_bit(
    indices: &[u8],
    k: u32,
    limits: &[u8; ROLE_COUNT],
    callback: &mut impl FnMut(&[u8; ROLE_COUNT]) -> bool,
) {
    let mut result = [0u8; ROLE_COUNT];
    combination_with_replacement_bit_inner(indices, k, limits, 0, &mut result, callback);
}

fn combination_with_replacement_bit_inner(
    indices: &[u8],
    k: u32,
    limits: &[u8; ROLE_COUNT],
    left: usize,
    result: &mut [u8; ROLE_COUNT],
    callback: &mut impl FnMut(&[u8; ROLE_COUNT]) -> bool,
) -> bool {
    if k == 0 {
        return callback(result);
    }
    if left >= indices.len() {
        return true;
    }
    for l in left..indices.len() {
        let idx = indices[l] as usize;
        if limits[idx] == 0 {
            continue;
        }
        let max = std::cmp::min(k, limits[idx] as u32);
        for count in 1..=max {
            result[idx] = count as u8;
            if !combination_with_replacement_bit_inner(
                indices,
                k - count,
                limits,
                l + 1,
                result,
                callback,
            ) {
                result[idx] = 0;
                return false;
            }
            result[idx] = 0;
        }
    }
    true
}

/// Higher-level combination with replacement using role names.
/// Returns all combinations as Vec of HashMaps.
pub fn combination_with_replacement_in_limit(
    roles: &[SystemRole],
    k: u32,
    limits: &HashMap<SystemRole, u32>,
) -> Vec<HashMap<SystemRole, u32>> {
    let mut results = Vec::new();
    let mut current = HashMap::new();
    combination_with_replacement_in_limit_inner(roles, k, limits, 0, &mut current, &mut results);
    results
}

fn combination_with_replacement_in_limit_inner(
    roles: &[SystemRole],
    k: u32,
    limits: &HashMap<SystemRole, u32>,
    left: usize,
    current: &mut HashMap<SystemRole, u32>,
    results: &mut Vec<HashMap<SystemRole, u32>>,
) {
    if left > roles.len() || k == 0 {
        results.push(current.clone());
        return;
    }
    let mut l = left;
    while l < roles.len() {
        let role = roles[l];
        let limit = limits.get(&role).copied().unwrap_or(0);
        if limit == 0 {
            l += 1;
            continue;
        }
        let max = std::cmp::min(k, limit);
        for count in 1..=max {
            current.insert(role, count);
            combination_with_replacement_in_limit_inner(roles, k - count, limits, l + 1, current, results);
            current.remove(&role);
        }
        l += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_setup(pairs: &[(SystemRole, u32)]) -> HashMap<SystemRole, u32> {
        pairs.iter().cloned().collect()
    }

    #[test]
    fn pop_count_basic() {
        assert_eq!(pop_count(0b10101010), 4);
        assert_eq!(pop_count(0), 0);
        assert_eq!(pop_count(0b11111111111), 11);
    }

    #[test]
    fn remove_role_from_possibility_test() {
        let p: u16 = 0b0011;
        let result = remove_role_from_possibility(p, SystemRole::Seer);
        assert_eq!(result, 0b0001);
    }

    #[test]
    fn has_role_in_possibility_true() {
        let p: u16 = 0b0011;
        assert!(has_role_in_possibility(p, SystemRole::Seer));
    }

    #[test]
    fn has_role_in_possibility_false() {
        let p: u16 = 0b0101;
        assert!(!has_role_in_possibility(p, SystemRole::Seer));
    }

    #[test]
    fn role_count_test() {
        assert_eq!(pop_count(0b10101010), 4);
    }

    #[test]
    fn set_of_roles_from_possibility_test() {
        let p: u16 = 0b10101010;
        let result = set_of_roles_from_possibility(p);
        let expected: HashSet<SystemRole> = [
            SystemRole::Seer,
            SystemRole::Bodyguard,
            SystemRole::Nekomata,
            SystemRole::Possessed,
        ]
        .into_iter()
        .collect();
        assert_eq!(result, expected);
    }

    #[test]
    fn set_of_roles_from_possibility_empty() {
        let result = set_of_roles_from_possibility(0);
        assert!(result.is_empty());
    }

    #[test]
    fn intersection_test() {
        let a: u16 = 0b10101010;
        let b: u16 = 0b11001100;
        assert_eq!(a & b, 0b10001000);
    }

    #[test]
    fn difference_test() {
        let a: u16 = 0b10101010;
        let b: u16 = 0b01010101;
        assert_eq!(a & !b, 0b10101010);
    }

    #[test]
    fn difference_with_overlap() {
        let a: u16 = 0b10101010;
        let b: u16 = 0b00001111;
        assert_eq!(a & !b, 0b10100000);
    }

    #[test]
    fn possibilities_init() {
        let setup = make_setup(&[
            (SystemRole::Seer, 2),
            (SystemRole::Bodyguard, 1),
            (SystemRole::Nekomata, 1),
            (SystemRole::Possessed, 1),
        ]);
        let p = Possibilities::from_setup(&setup);
        assert_eq!(p.seat_count(), 5);
        let cloned = p.clone_instance();
        assert_eq!(p.possibilities, cloned.possibilities);
    }

    #[test]
    fn fix_role_test() {
        let setup = make_setup(&[
            (SystemRole::Seer, 1),
            (SystemRole::Bodyguard, 1),
            (SystemRole::Nekomata, 1),
            (SystemRole::Possessed, 1),
        ]);
        let mut p = Possibilities::from_setup(&setup);
        let result = p.fix_role(1, SystemRole::Nekomata);
        assert!(result);
        assert!(has_role_in_possibility(p.get(1), SystemRole::Nekomata));
        assert_eq!(pop_count(p.get(1)), 1);
        assert!(!has_role_in_possibility(p.get(2), SystemRole::Nekomata));
    }

    #[test]
    fn fix_role_unavailable() {
        let setup = make_setup(&[
            (SystemRole::Seer, 0),
            (SystemRole::Bodyguard, 1),
            (SystemRole::Nekomata, 1),
            (SystemRole::Possessed, 1),
        ]);
        let mut p = Possibilities::from_setup(&setup);
        // seer has count 0, but initial mask only includes roles with count > 0
        // so seer bit won't be in possibilities at all
        let result = p.fix_role(1, SystemRole::Seer);
        assert!(!result);
    }

    #[test]
    fn mark_as_liar_test() {
        let setup = make_setup(&[
            (SystemRole::Seer, 1),
            (SystemRole::Bodyguard, 1),
            (SystemRole::Nekomata, 1),
            (SystemRole::Possessed, 1),
        ]);
        let mut p = Possibilities::from_setup(&setup);
        p.mark_as_liar(1);
        let roles = set_of_roles_from_possibility(p.get(1));
        let expected: HashSet<SystemRole> = [SystemRole::Possessed].into_iter().collect();
        assert_eq!(roles, expected);
    }

    #[test]
    fn mark_as_human_test() {
        let setup = make_setup(&[
            (SystemRole::Seer, 1),
            (SystemRole::Bodyguard, 1),
            (SystemRole::Werewolf, 1),
            (SystemRole::Nekomata, 1),
            (SystemRole::Possessed, 1),
        ]);
        let mut p = Possibilities::from_setup(&setup);
        p.mark_as_human(1);
        let roles = set_of_roles_from_possibility(p.get(1));
        let expected: HashSet<SystemRole> = [
            SystemRole::Seer,
            SystemRole::Bodyguard,
            SystemRole::Nekomata,
            SystemRole::Possessed,
        ]
        .into_iter()
        .collect();
        assert_eq!(roles, expected);
    }

    #[test]
    fn deny_role_test() {
        let setup = make_setup(&[
            (SystemRole::Seer, 1),
            (SystemRole::Bodyguard, 1),
            (SystemRole::Nekomata, 1),
            (SystemRole::Possessed, 1),
        ]);
        let mut p = Possibilities::from_setup(&setup);
        p.deny_role(1, SystemRole::Seer);
        assert!(!has_role_in_possibility(p.get(1), SystemRole::Seer));
        assert!(has_role_in_possibility(p.get(1), SystemRole::Bodyguard));
        assert!(has_role_in_possibility(p.get(1), SystemRole::Nekomata));
        assert!(has_role_in_possibility(p.get(1), SystemRole::Possessed));
    }

    #[test]
    fn union_test() {
        let setup = make_setup(&[
            (SystemRole::Seer, 1),
            (SystemRole::Bodyguard, 1),
            (SystemRole::Nekomata, 1),
            (SystemRole::Possessed, 1),
        ]);
        let mut pa = Possibilities::from_setup(&setup);
        pa.set(1, possibility_from_roles(&[SystemRole::Seer, SystemRole::Bodyguard].into_iter().collect()));
        pa.set(2, possibility_from_roles(&[SystemRole::Possessed].into_iter().collect()));

        let mut pb = Possibilities::from_setup(&setup);
        pb.set(1, possibility_from_roles(&[SystemRole::Bodyguard].into_iter().collect()));
        pb.set(2, possibility_from_roles(&[SystemRole::Seer].into_iter().collect()));

        pa.union(&pb);

        assert!(pa.has_role(1, SystemRole::Seer));
        assert!(pa.has_role(1, SystemRole::Bodyguard));
        assert!(!pa.has_role(1, SystemRole::Nekomata));
        assert!(!pa.has_role(1, SystemRole::Possessed));
        assert!(pa.has_role(2, SystemRole::Seer));
        assert!(!pa.has_role(2, SystemRole::Bodyguard));
        assert!(!pa.has_role(2, SystemRole::Nekomata));
        assert!(pa.has_role(2, SystemRole::Possessed));
    }

    #[test]
    fn to_structured_test() {
        let setup = make_setup(&[
            (SystemRole::Seer, 1),
            (SystemRole::Bodyguard, 1),
            (SystemRole::Nekomata, 1),
            (SystemRole::Possessed, 1),
        ]);
        let mut p = Possibilities::from_setup(&setup);
        p.fix_role(1, SystemRole::Seer);
        p.fix_role(2, SystemRole::Bodyguard);
        p.fix_role(3, SystemRole::Nekomata);
        p.fix_role(4, SystemRole::Possessed);

        let result = p.to_structured();

        assert_eq!(result.len(), 4);
        assert_eq!(result[&1], [SystemRole::Seer].into_iter().collect());
        assert_eq!(result[&2], [SystemRole::Bodyguard].into_iter().collect());
        assert_eq!(result[&3], [SystemRole::Nekomata].into_iter().collect());
        assert_eq!(result[&4], [SystemRole::Possessed].into_iter().collect());
    }

    #[test]
    fn combination_with_replacement_in_limit_test() {
        let roles = vec![SystemRole::Seer, SystemRole::Bodyguard, SystemRole::Nekomata];
        let limits: HashMap<SystemRole, u32> = [
            (SystemRole::Seer, 1),
            (SystemRole::Bodyguard, 2),
            (SystemRole::Nekomata, 1),
        ]
        .into_iter()
        .collect();

        let result = combination_with_replacement_in_limit(&roles, 2, &limits);

        assert_eq!(result.len(), 4);
        // {seer: 1, bodyguard: 1}
        assert!(result.contains(&[(SystemRole::Seer, 1), (SystemRole::Bodyguard, 1)].into_iter().collect()));
        // {seer: 1, nekomata: 1}
        assert!(result.contains(&[(SystemRole::Seer, 1), (SystemRole::Nekomata, 1)].into_iter().collect()));
        // {bodyguard: 1, nekomata: 1}
        assert!(result.contains(&[(SystemRole::Bodyguard, 1), (SystemRole::Nekomata, 1)].into_iter().collect()));
        // {bodyguard: 2}
        assert!(result.contains(&[(SystemRole::Bodyguard, 2)].into_iter().collect()));
    }

    #[test]
    fn combination_with_replacement_bit_test() {
        let indices = vec![1u8, 3, 5]; // seer, bodyguard, nekomata
        let mut limits = [0u8; ROLE_COUNT];
        limits[1] = 1; // seer
        limits[3] = 2; // bodyguard
        limits[5] = 1; // nekomata

        let mut results = Vec::new();
        combination_with_replacement_bit(&indices, 2, &limits, &mut |result| {
            results.push(*result);
            true
        });

        assert_eq!(results.len(), 4);
    }
}
