use crate::types::{SystemRole, Seat};
use std::collections::{BTreeMap, BTreeSet};

pub const ROLE_COUNT: usize = 12;
/// in_pending が u32 ビットマスクなので最大32席（seat 1..=31）
pub const MAX_SEATS: usize = 32;

// Composite bitmask constants
pub const ALL_ROLES: u16 = (1u16 << ROLE_COUNT) - 1; // 0b111111111111
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
    | SystemRole::Immoralist.bit_const()
    | SystemRole::Paparazzi.bit_const();

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
            SystemRole::Paparazzi => 11,
        }
    }
}

#[inline]
pub fn pop_count(x: u16) -> u32 {
    x.count_ones()
}

pub fn role_count(possibility: u16) -> u32 {
    possibility.count_ones()
}

pub fn intersection_of_role_possibility(a: u16, b: u16) -> u16 {
    a & b
}

pub fn difference_of_role_possibilities(a: u16, b: u16) -> u16 {
    a & !b
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

pub fn set_of_roles_from_possibility(possibility: u16) -> BTreeSet<SystemRole> {
    let mut result = BTreeSet::new();
    for role in SystemRole::ALL {
        if possibility & role.bit() != 0 {
            result.insert(role);
        }
    }
    result
}

pub fn possibility_from_roles(roles: &BTreeSet<SystemRole>) -> u16 {
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Possibilities {
    pub possibilities: Vec<u16>,
    pub setup: [u8; ROLE_COUNT],
    pub setup_original: [u8; ROLE_COUNT],
    /// 最大生存人外数（compute_max_surviving_nv() で設定）
    pub max_surviving_nv: i32,
}

impl Possibilities {
    /// Create from a setup map (role → count). Initializes all seats with all roles present in setup.
    pub fn from_setup(setup: &BTreeMap<SystemRole, u32>) -> Self {
        let mut count: usize = 0;
        let mut initial: u16 = 0;
        let mut setup_arr = [0u8; ROLE_COUNT];
        for (&role, &num) in setup {
            setup_arr[role.bit_index() as usize] = num as u8;
            count += num as usize;
            initial |= role.bit();
        }
        assert!(
            count < MAX_SEATS,
            "seat count {} exceeds maximum supported ({})",
            count, MAX_SEATS - 1,
        );
        let setup_original = setup_arr;
        let mut possibilities = vec![0u16; count + 1]; // index 0 unused
        for i in 1..=count {
            possibilities[i] = initial;
        }
        Possibilities {
            possibilities,
            setup: setup_arr,
            setup_original,
            max_surviving_nv: 0,
        }
    }

    /// Create empty (all zeros) with same dimensions as setup
    pub fn empty(setup: &BTreeMap<SystemRole, u32>) -> Self {
        let mut p = Self::from_setup(setup);
        for i in 0..p.possibilities.len() {
            p.possibilities[i] = 0;
        }
        p
    }


    pub fn seat_count(&self) -> usize {
        self.possibilities.len() - 1
    }

    pub fn clone_instance(&self) -> Self {
        Possibilities {
            possibilities: self.possibilities.clone(),
            setup: self.setup,
            setup_original: self.setup_original,
            max_surviving_nv: self.max_surviving_nv,
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
        let mut buf = [0u8; MAX_SEATS];
        buf[0] = seat as u8;
        self.drain(&mut buf, 0, 1, 1u32 << seat)
    }

    pub fn refix(&mut self) -> bool {
        self.setup = self.setup_original;
        let mut buf = [0u8; MAX_SEATS];
        let mut tail: usize = 0;
        let mut in_pending: u32 = 0;
        for i in 1..self.possibilities.len() {
            if pop_count(self.possibilities[i]) == 1 {
                buf[tail] = i as u8;
                tail += 1;
                in_pending |= 1u32 << i;
            }
        }
        self.drain(&mut buf, 0, tail, in_pending)
    }

    /// ワークリストを処理し、全 singleton のカスケードを伝播する
    fn drain(&mut self, buf: &mut [u8; MAX_SEATS], mut head: usize, mut tail: usize, mut in_pending: u32) -> bool {
        while head < tail {
            let s = buf[head] as usize;
            head += 1;
            let p = self.possibilities[s];
            let count = pop_count(p);
            if count == 0 {
                return false;
            }
            if count != 1 {
                continue;
            }

            let bit_idx = p.trailing_zeros() as usize;
            if self.setup[bit_idx] == 0 {
                return false;
            }

            if self.setup[bit_idx] == 1 {
                for i in 1..self.possibilities.len() {
                    if i == s {
                        continue;
                    }
                    if self.possibilities[i] == p {
                        continue;
                    }
                    let old = self.possibilities[i];
                    self.possibilities[i] &= !p;
                    if self.possibilities[i] == 0 {
                        return false;
                    }
                    if pop_count(old) > 1 && pop_count(self.possibilities[i]) == 1 && (in_pending & (1u32 << i)) == 0 {
                        buf[tail] = i as u8;
                        tail += 1;
                        in_pending |= 1u32 << i;
                    }
                }
            }
            self.setup[bit_idx] -= 1;
        }
        true
    }

    /// refix + hidden singles を fixpoint まで反復する。
    /// hidden singles: 役職 R の残カウントと候補席数が一致 → 全候補を R に確定。
    /// finalize() の solver 呼び出し前に最大限の席を確定させる。
    pub fn propagate_full(&mut self) -> bool {
        loop {
            if !self.refix() {
                return false;
            }
            let mut changed = false;
            for bit_idx in 0..ROLE_COUNT {
                let remaining = self.setup[bit_idx];
                if remaining == 0 {
                    continue;
                }
                let bit: u16 = 1 << bit_idx;
                let mut candidate_count: u8 = 0;
                for i in 1..self.possibilities.len() {
                    if pop_count(self.possibilities[i]) > 1 && (self.possibilities[i] & bit) != 0 {
                        candidate_count += 1;
                    }
                }
                if candidate_count < remaining {
                    return false;
                }
                if candidate_count == remaining {
                    for i in 1..self.possibilities.len() {
                        if pop_count(self.possibilities[i]) > 1 && (self.possibilities[i] & bit) != 0 {
                            self.possibilities[i] = bit;
                            changed = true;
                        }
                    }
                }
            }
            if !changed {
                return true;
            }
        }
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

    pub fn to_structured(&self) -> BTreeMap<Seat, BTreeSet<SystemRole>> {
        let mut result = BTreeMap::new();
        for i in 1..self.possibilities.len() {
            result.insert(i as Seat, set_of_roles_from_possibility(self.possibilities[i]));
        }
        result
    }

    /// 最大生存人外数を計算し max_surviving_nv に格納する。
    /// 二部マッチングにより死亡者を村役職スロットに最大割り当てし、
    /// 配役上の人外総数から最小死亡人外数を差し引く。
    pub fn compute_max_surviving_nv(&mut self, alive: u32) {
        let village_mask = !LIAR & ALL_ROLES;

        // 配役上の人外総数
        let mut total_nv: i32 = 0;
        for i in 0..ROLE_COUNT {
            if ((1u16 << i) & LIAR) != 0 {
                total_nv += self.setup_original[i] as i32;
            }
        }

        // 死者席を収集
        let mut dead_seats: Vec<usize> = Vec::new();
        for seat in 1..self.possibilities.len() {
            if (alive & (1u32 << seat)) == 0 {
                dead_seats.push(seat);
            }
        }
        if dead_seats.is_empty() {
            self.max_surviving_nv = total_nv;
            return;
        }

        // 村役職スロットを容量展開
        let mut village_slots: Vec<u16> = Vec::new();
        for i in 0..ROLE_COUNT {
            if ((1u16 << i) & village_mask) == 0 {
                continue;
            }
            let bit = 1u16 << i;
            for _ in 0..self.setup_original[i] {
                village_slots.push(bit);
            }
        }
        if village_slots.is_empty() {
            self.max_surviving_nv = total_nv;
            return;
        }

        // Kuhn's augmenting path matching
        let dead_count = dead_seats.len();
        let mut match_dead: Vec<i32> = vec![-1; dead_count];
        let mut visited: Vec<bool> = vec![false; dead_count];

        let mut max_dead_village: i32 = 0;
        for si in 0..village_slots.len() {
            visited.fill(false);
            if try_augment_village_slot(
                si,
                &village_slots,
                &dead_seats,
                &self.possibilities,
                &mut match_dead,
                &mut visited,
            ) {
                max_dead_village += 1;
            }
        }

        self.max_surviving_nv = (total_nv - (dead_count as i32 - max_dead_village)).max(0);
    }
}

/// 二部マッチングの増加パス探索（Kuhn's algorithm）
fn try_augment_village_slot(
    slot_idx: usize,
    village_slots: &[u16],
    dead_seats: &[usize],
    possibilities: &[u16],
    match_dead: &mut [i32],
    visited: &mut [bool],
) -> bool {
    let slot_bit = village_slots[slot_idx];
    for di in 0..dead_seats.len() {
        if visited[di] {
            continue;
        }
        if (possibilities[dead_seats[di]] & slot_bit) == 0 {
            continue;
        }
        visited[di] = true;
        if match_dead[di] == -1
            || try_augment_village_slot(
                match_dead[di] as usize,
                village_slots,
                dead_seats,
                possibilities,
                match_dead,
                visited,
            )
        {
            match_dead[di] = slot_idx as i32;
            return true;
        }
    }
    false
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
/// Returns all combinations as Vec of BTreeMaps.
pub fn combination_with_replacement_in_limit(
    roles: &[SystemRole],
    k: u32,
    limits: &BTreeMap<SystemRole, u32>,
) -> Vec<BTreeMap<SystemRole, u32>> {
    let mut results = Vec::new();
    let mut current = BTreeMap::new();
    combination_with_replacement_in_limit_inner(roles, k, limits, 0, &mut current, &mut results);
    results
}

fn combination_with_replacement_in_limit_inner(
    roles: &[SystemRole],
    k: u32,
    limits: &BTreeMap<SystemRole, u32>,
    left: usize,
    current: &mut BTreeMap<SystemRole, u32>,
    results: &mut Vec<BTreeMap<SystemRole, u32>>,
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

    fn make_setup(pairs: &[(SystemRole, u32)]) -> BTreeMap<SystemRole, u32> {
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
        let expected: BTreeSet<SystemRole> = [
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
        let expected: BTreeSet<SystemRole> = [SystemRole::Possessed].into_iter().collect();
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
        let expected: BTreeSet<SystemRole> = [
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
        let limits: BTreeMap<SystemRole, u32> = [
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

    #[test]
    fn from_setup_max_seats_boundary() {
        // 31席（MAX_SEATS - 1）: ちょうど上限 → パニックしない
        let setup = make_setup(&[
            (SystemRole::Villager, 25),
            (SystemRole::Werewolf, 5),
            (SystemRole::Seer, 1),
        ]);
        let p = Possibilities::from_setup(&setup);
        assert_eq!(p.seat_count(), 31);
    }

    #[test]
    #[should_panic(expected = "seat count 32 exceeds maximum supported")]
    fn from_setup_exceeds_max_seats() {
        // 32席（MAX_SEATS）: 上限超過 → パニック
        let setup = make_setup(&[
            (SystemRole::Villager, 26),
            (SystemRole::Werewolf, 5),
            (SystemRole::Seer, 1),
        ]);
        Possibilities::from_setup(&setup);
    }

    #[test]
    fn fix_cascade_at_max_seats() {
        // 31席で全席 fix_role → drain の buf が溢れないことを確認
        let setup = make_setup(&[
            (SystemRole::Villager, 20),
            (SystemRole::Seer, 1),
            (SystemRole::Medium, 1),
            (SystemRole::Bodyguard, 1),
            (SystemRole::Mason, 2),
            (SystemRole::Nekomata, 1),
            (SystemRole::Werewolf, 3),
            (SystemRole::Possessed, 1),
            (SystemRole::Werehamster, 1),
        ]);
        let mut p = Possibilities::from_setup(&setup);
        assert_eq!(p.seat_count(), 31);
        // 全席を順に fix しても panic しないこと
        let roles = [
            SystemRole::Seer, SystemRole::Medium, SystemRole::Bodyguard,
            SystemRole::Mason, SystemRole::Mason, SystemRole::Nekomata,
            SystemRole::Werewolf, SystemRole::Werewolf, SystemRole::Werewolf,
            SystemRole::Possessed, SystemRole::Werehamster,
        ];
        for (i, &role) in roles.iter().enumerate() {
            p.fix_role((i + 1) as Seat, role);
        }
    }
}
