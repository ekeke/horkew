//! 役職集合 helper. systemRoles (Rust では SystemRole::ALL + faction()/seer_result()/traits())
//! を ground truth に派生する.
//!
//! 役職追加時は src/retar-rs/src/types.rs の SystemRole enum に variant を追加するだけで
//! これらの helper は自動追従する.
//!
//! TS 側 src/retar/role-sets.ts と関数名・semantics を 1:1 で揃える (sync-check 規約).

use crate::types::{EnumSpecies, Faction, RoleTrait, SystemRole};
use std::collections::BTreeMap;

/// systemRoles に登録されている全役職 (setup 非依存). 宣言順を保つ.
pub fn all_known_roles() -> Vec<SystemRole> {
    SystemRole::ALL.to_vec()
}

/// systemRoles に登録されている全 村陣営役職 (setup 非依存).
pub fn all_village_roles() -> Vec<SystemRole> {
    SystemRole::ALL
        .iter()
        .copied()
        .filter(|r| r.faction() == Faction::Village)
        .collect()
}

/// systemRoles に登録されている全 人外陣営役職 (= faction !== village, setup 非依存).
pub fn all_liar_roles() -> Vec<SystemRole> {
    SystemRole::ALL
        .iter()
        .copied()
        .filter(|r| r.faction() != Faction::Village)
        .collect()
}

/// setup に含まれる役職 (count > 0).
pub fn all_roles_in(setup: &BTreeMap<SystemRole, u32>) -> Vec<SystemRole> {
    setup
        .iter()
        .filter_map(|(&role, &count)| if count > 0 { Some(role) } else { None })
        .collect()
}

/// setup に含まれる村陣営役職.
pub fn village_roles_in(setup: &BTreeMap<SystemRole, u32>) -> Vec<SystemRole> {
    all_roles_in(setup)
        .into_iter()
        .filter(|r| r.faction() == Faction::Village)
        .collect()
}

/// setup に含まれる嘘つき役職 (faction != village).
/// 旧 plan_builder.rs の LIAR_ROLES を setup フィルタ + 派生にしたもの.
pub fn liar_roles_in(setup: &BTreeMap<SystemRole, u32>) -> Vec<SystemRole> {
    all_roles_in(setup)
        .into_iter()
        .filter(|r| r.faction() != Faction::Village)
        .collect()
}

/// setup に含まれる人間種別 (seerResult == Human) 役職.
pub fn human_roles_in(setup: &BTreeMap<SystemRole, u32>) -> Vec<SystemRole> {
    all_roles_in(setup)
        .into_iter()
        .filter(|r| r.seer_result() == EnumSpecies::Human)
        .collect()
}

/// setup に含まれる「通常 CO 経由で plan する村陣営能力者」(faction=village かつ非 passive
/// trait を持つ + contractor 除外).
/// 旧 plan_builder.rs の ROLES_IN_TEST_PLANNING を setup フィルタ + 派生にしたもの.
///
/// 非 passive trait = action / auto-info / knowledge / reactive / channel.
/// passive のみの trait (例: contractor の pair-required) は setup 制約であって
/// 役職テスト対象の能力ではないため planning 対象から除外する.
///
/// contractor は宇理炎の能力で auto-info trait を持つが、 CO ではなく公示 (announce) で
/// 配置が確定する「公示専用役職」なので、 通常の planning から除外する。
/// 公示で全席確定された場合のみ plan_builder の announce-fixed 動的追加経路で planning に乗る。
pub fn powered_village_roles_in(setup: &BTreeMap<SystemRole, u32>) -> Vec<SystemRole> {
    all_roles_in(setup)
        .into_iter()
        .filter(|&r| {
            r.faction() == Faction::Village
                && r != SystemRole::Contractor
                && r.traits().iter().any(|t| !t.is_passive())
        })
        .collect()
}

/// 指定 role が trait を持つかチェック.
pub fn has_trait(role: SystemRole, t: RoleTrait) -> bool {
    role.traits().iter().any(|&x| x == t)
}

/// setup に含まれる「trait を持つ役職」のリスト.
pub fn roles_with_trait_in(setup: &BTreeMap<SystemRole, u32>, t: RoleTrait) -> Vec<SystemRole> {
    all_roles_in(setup)
        .into_iter()
        .filter(|&r| has_trait(r, t))
        .collect()
}

/// setup に含まれる「seerResult が指定種別の役職」のリスト.
pub fn roles_by_seer_result_in(
    setup: &BTreeMap<SystemRole, u32>,
    result: EnumSpecies,
) -> Vec<SystemRole> {
    all_roles_in(setup)
        .into_iter()
        .filter(|r| r.seer_result() == result)
        .collect()
}

/// trait を持つ役職を systemRoles から全て返す (setup 非依存).
/// roles_with_trait_in の setup フィルタ無し版. fixed_positions の確定先など、
/// setup に存在しなくても systemRoles レベルで意味のある役職を取り出す場面で使う.
pub fn roles_by_trait(t: RoleTrait) -> Vec<SystemRole> {
    SystemRole::ALL
        .iter()
        .copied()
        .filter(|&r| has_trait(r, t))
        .collect()
}

/// trait を持つ役職を systemRoles から 1 つだけ返す (setup 非依存). 0 件 or 複数件で panic.
pub fn single_role_by_trait(t: RoleTrait) -> SystemRole {
    let matched: Vec<SystemRole> = SystemRole::ALL
        .iter()
        .copied()
        .filter(|&r| has_trait(r, t))
        .collect();
    assert_eq!(
        matched.len(),
        1,
        "single_role_by_trait({:?}) expected exactly 1 role, got {}: {:?}",
        t,
        matched.len(),
        matched
    );
    matched[0]
}

/// seerResult が指定種別の役職を systemRoles から全て返す (setup 非依存).
/// roles_by_seer_result_in の setup フィルタ無し版.
pub fn roles_by_seer_result(result: EnumSpecies) -> Vec<SystemRole> {
    SystemRole::ALL
        .iter()
        .copied()
        .filter(|&r| r.seer_result() == result)
        .collect()
}

/// seerResult が指定種別の役職を systemRoles から 1 つだけ返す (setup 非依存).
pub fn single_role_by_seer_result(result: EnumSpecies) -> SystemRole {
    let matched: Vec<SystemRole> = SystemRole::ALL
        .iter()
        .copied()
        .filter(|r| r.seer_result() == result)
        .collect();
    assert_eq!(
        matched.len(),
        1,
        "single_role_by_seer_result({:?}) expected exactly 1 role, got {}: {:?}",
        result,
        matched.len(),
        matched
    );
    matched[0]
}

/// predicate を満たす役職を systemRoles から 1 つだけ返す (setup 非依存).
pub fn single_role_by_predicate(predicate: impl Fn(SystemRole) -> bool) -> SystemRole {
    let matched: Vec<SystemRole> = SystemRole::ALL.iter().copied().filter(|&r| predicate(r)).collect();
    assert_eq!(
        matched.len(),
        1,
        "single_role_by_predicate expected exactly 1 role, got {}: {:?}",
        matched.len(),
        matched
    );
    matched[0]
}

/// setup に含まれる「trait を持つ役職」の count 合計.
pub fn count_by_trait_in(setup: &BTreeMap<SystemRole, u32>, t: RoleTrait) -> u32 {
    roles_with_trait_in(setup, t)
        .into_iter()
        .map(|r| setup.get(&r).copied().unwrap_or(0))
        .sum()
}

/// setup に含まれる「seerResult が指定種別の役職」の count 合計.
pub fn count_by_seer_result_in(setup: &BTreeMap<SystemRole, u32>, result: EnumSpecies) -> u32 {
    roles_by_seer_result_in(setup, result)
        .into_iter()
        .map(|r| setup.get(&r).copied().unwrap_or(0))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn make(entries: &[(SystemRole, u32)]) -> BTreeMap<SystemRole, u32> {
        entries.iter().copied().collect()
    }

    #[test]
    fn all_known_roles_contains_paparazzi() {
        let all = all_known_roles();
        assert!(all.contains(&SystemRole::Paparazzi));
        assert!(all.len() >= 12);
    }

    #[test]
    fn liar_roles_in_filters_by_setup() {
        let setup = make(&[(SystemRole::Villager, 3), (SystemRole::Werewolf, 1)]);
        let got = liar_roles_in(&setup);
        assert_eq!(got, vec![SystemRole::Werewolf]);
        assert!(!got.contains(&SystemRole::Paparazzi));
    }

    #[test]
    fn single_role_by_seer_result_wolf_is_werewolf() {
        assert_eq!(single_role_by_seer_result(EnumSpecies::Wolf), SystemRole::Werewolf);
    }

    #[test]
    fn single_role_by_trait_die_when_divined_is_werehamster() {
        assert_eq!(
            single_role_by_trait(RoleTrait::PassiveDieWhenDivined),
            SystemRole::Werehamster
        );
    }

    #[test]
    fn count_by_trait_in_follow_fox_death() {
        let setup = make(&[(SystemRole::Villager, 3), (SystemRole::Immoralist, 2)]);
        assert_eq!(count_by_trait_in(&setup, RoleTrait::ReactiveFollowFoxDeath), 2);
    }
}
