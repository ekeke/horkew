use serde::{Deserialize, Serialize, Deserializer};
use std::collections::BTreeMap;
use std::fmt;

pub type Seat = u32;
pub type Day = i32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemRole {
    Villager,
    Seer,
    Medium,
    Bodyguard,
    Mason,
    Nekomata,
    Werewolf,
    Possessed,
    Fanatic,
    Werehamster,
    Immoralist,
    Paparazzi,
}

impl SystemRole {
    pub const ALL: [SystemRole; 12] = [
        SystemRole::Villager,
        SystemRole::Seer,
        SystemRole::Medium,
        SystemRole::Bodyguard,
        SystemRole::Mason,
        SystemRole::Nekomata,
        SystemRole::Werewolf,
        SystemRole::Possessed,
        SystemRole::Fanatic,
        SystemRole::Werehamster,
        SystemRole::Immoralist,
        SystemRole::Paparazzi,
    ];

    pub fn bit(self) -> u16 {
        1u16 << self.bit_index()
    }

    pub fn bit_index(self) -> u8 {
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

    pub fn from_bit_index(idx: u8) -> Option<SystemRole> {
        match idx {
            0 => Some(SystemRole::Villager),
            1 => Some(SystemRole::Seer),
            2 => Some(SystemRole::Medium),
            3 => Some(SystemRole::Bodyguard),
            4 => Some(SystemRole::Mason),
            5 => Some(SystemRole::Nekomata),
            6 => Some(SystemRole::Werewolf),
            7 => Some(SystemRole::Possessed),
            8 => Some(SystemRole::Fanatic),
            9 => Some(SystemRole::Werehamster),
            10 => Some(SystemRole::Immoralist),
            11 => Some(SystemRole::Paparazzi),
            _ => None,
        }
    }

    /// TS systemRoles.get(role).traits 相当: 役職に紐付く trait の集合
    pub fn traits(self) -> &'static [RoleTrait] {
        match self {
            SystemRole::Villager => &[],
            SystemRole::Seer => &[RoleTrait::ActionDivine],
            SystemRole::Medium => &[RoleTrait::AutoInfoExecutionSpecies],
            SystemRole::Bodyguard => &[RoleTrait::ActionGuard],
            SystemRole::Mason => &[RoleTrait::KnowledgeKnowMasons],
            SystemRole::Nekomata => &[
                RoleTrait::ReactiveCurseOnExecuted,
                RoleTrait::ReactiveCurseOnKilled,
            ],
            SystemRole::Werewolf => &[
                RoleTrait::KnowledgeKnowWerewolves,
                RoleTrait::ActionAttack,
                RoleTrait::ChannelWolfChat,
            ],
            SystemRole::Possessed => &[],
            SystemRole::Fanatic => &[RoleTrait::KnowledgeKnowWerewolves],
            SystemRole::Werehamster => &[
                RoleTrait::PassiveAttackImmune,
                RoleTrait::PassiveDieWhenDivined,
            ],
            SystemRole::Immoralist => &[RoleTrait::KnowledgeKnowFoxes],
            SystemRole::Paparazzi => &[RoleTrait::ActionDivine],
        }
    }
}

impl fmt::Display for SystemRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SystemRole::Villager => write!(f, "villager"),
            SystemRole::Seer => write!(f, "seer"),
            SystemRole::Medium => write!(f, "medium"),
            SystemRole::Bodyguard => write!(f, "bodyguard"),
            SystemRole::Mason => write!(f, "mason"),
            SystemRole::Nekomata => write!(f, "nekomata"),
            SystemRole::Werewolf => write!(f, "werewolf"),
            SystemRole::Possessed => write!(f, "possessed"),
            SystemRole::Fanatic => write!(f, "fanatic"),
            SystemRole::Werehamster => write!(f, "werehamster"),
            SystemRole::Immoralist => write!(f, "immoralist"),
            SystemRole::Paparazzi => write!(f, "paparazzi"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Faction {
    Village,
    Wolf,
    Fox,
}

/// TS RoleTrait 相当: { kind, sub } の組を flat な variant に展開した形
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RoleTrait {
    PassiveAttackImmune,
    PassiveDieWhenDivined,
    KnowledgeKnowWerewolves,
    KnowledgeKnowFoxes,
    KnowledgeKnowMasons,
    ActionDivine,
    ActionGuard,
    ActionAttack,
    ReactiveCurseOnExecuted,
    ReactiveCurseOnKilled,
    AutoInfoExecutionSpecies,
    ChannelWolfChat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CauseOfDeath {
    Execution,
    NightKill,
    FollowExecutedHamster,
    FollowKilledHamster,
    CursedByExecutedNekomata,
    CursedByKilledNekomata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VillageResult {
    WerewolfWon,
    VillagerWon,
    WerehamsterWon,
    Draw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnumSpecies {
    Human,
    Wolf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assertion {
    pub target: Seat,
    pub species: Option<EnumSpecies>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviousClaim {
    pub role: String,
    #[serde(deserialize_with = "deserialize_day_map")]
    pub assertions: BTreeMap<Day, Assertion>,
    #[serde(deserialize_with = "deserialize_day_seat_map")]
    pub actions: BTreeMap<Day, Seat>,
    #[serde(deserialize_with = "deserialize_day_seat_map")]
    pub forecasts: BTreeMap<Day, Seat>,
    #[serde(rename = "claimedAt")]
    pub claimed_at: Option<Day>,
    #[serde(rename = "claimOrder")]
    pub claim_order: Option<u32>,
    #[serde(rename = "slidToRole")]
    pub slid_to_role: String,
    #[serde(rename = "slidDay")]
    pub slid_day: Day,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeatStatus {
    pub surviving: bool,
    #[serde(rename = "causeOfDeath")]
    pub cause_of_death: CauseOfDeath,
    #[serde(rename = "survivedDays")]
    pub survived_days: u32,
    #[serde(rename = "diedDay")]
    pub died_day: Option<Day>,
    pub voted: bool,
    pub claiming: bool,
    #[serde(rename = "claimedAt")]
    pub claimed_at: Option<Day>,
    #[serde(rename = "claimOrder")]
    pub claim_order: Option<u32>,
    #[serde(rename = "claimingRole")]
    pub claiming_role: String,
    #[serde(rename = "deniedRoles", default)]
    pub denied_roles: Vec<SystemRole>,
    #[serde(rename = "votedCount")]
    pub voted_count: u32,
    #[serde(rename = "votedTarget")]
    pub voted_target: i32,
    #[serde(rename = "votedOrder")]
    pub voted_order: u32,
    #[serde(deserialize_with = "deserialize_day_seat_map")]
    pub actions: BTreeMap<Day, Seat>,
    #[serde(deserialize_with = "deserialize_day_map")]
    pub assertions: BTreeMap<Day, Assertion>,
    #[serde(deserialize_with = "deserialize_day_seat_map")]
    pub forecasts: BTreeMap<Day, Seat>,
    #[serde(rename = "noCoOpportunity", default)]
    pub no_co_opportunity: Option<bool>,
    #[serde(rename = "previousAssertions", default, deserialize_with = "deserialize_optional_day_assertion_vec_map")]
    pub previous_assertions: Option<BTreeMap<Day, Vec<Assertion>>>,
    #[serde(rename = "previousClaims", default)]
    pub previous_claims: Option<Vec<PreviousClaim>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoteRecord {
    pub voter: Seat,
    pub target: Seat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VillageStatus {
    #[serde(deserialize_with = "deserialize_seat_status_map")]
    pub statuses: BTreeMap<Seat, SeatStatus>,
    #[serde(deserialize_with = "deserialize_day_seat_vec_map")]
    pub executions: BTreeMap<Day, Vec<Seat>>,
    #[serde(deserialize_with = "deserialize_day_seat_vec_map")]
    pub kills: BTreeMap<Day, Vec<Seat>>,
    #[serde(rename = "voteHistory", deserialize_with = "deserialize_day_vote_map")]
    pub vote_history: BTreeMap<Day, Vec<VoteRecord>>,
    #[serde(rename = "revoteTargets", default)]
    pub revote_targets: Vec<Seat>,
    #[serde(rename = "voteFinalRule", default = "default_vote_final_rule")]
    pub vote_final_rule: String,
    #[serde(rename = "hasMultiVote", default)]
    pub has_multi_vote: bool,
    #[serde(rename = "multiVoteDays", default)]
    pub multi_vote_days: Vec<Day>,
    pub day: Day,
    pub finished: bool,
    pub result: Option<VillageResult>,
}

fn default_vote_final_rule() -> String {
    "revote".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeOptions {
    #[serde(rename = "seerClaimingDueDate")]
    pub seer_claiming_due_date: Day,
    #[serde(rename = "mediumClaimingDueDate")]
    pub medium_claiming_due_date: Day,
    #[serde(rename = "bodyguardClaimingDueDate")]
    pub bodyguard_claiming_due_date: Day,
    #[serde(rename = "masonClaimingDueDate")]
    pub mason_claiming_due_date: Day,
    #[serde(rename = "nekomataClaimingDueDate")]
    pub nekomata_claiming_due_date: Day,
    #[serde(rename = "dayCountFrom")]
    pub day_count_from: Day,
    #[serde(rename = "hasFirstGhost")]
    pub has_first_ghost: bool,
    #[serde(deserialize_with = "deserialize_seat_role_map", default)]
    pub assumptions: BTreeMap<Seat, SystemRole>,
    #[serde(rename = "wolfPairDenyals", default)]
    pub wolf_pair_denyals: Vec<(Seat, Seat)>,
    #[serde(rename = "hocusPocus", deserialize_with = "deserialize_seat_bool_map", default)]
    pub hocus_pocus: BTreeMap<Seat, bool>,
    #[serde(default)]
    pub id: u32,
    #[serde(default = "default_batches")]
    pub batches: u32,
    #[serde(default)]
    pub batch: u32,

    /// 事前計算済みinitialPossibilitiesを基に再計算する場合に指定
    #[serde(default)]
    pub prior: Option<crate::possibilities::Possibilities>,
}

fn default_batches() -> u32 {
    1
}

// Custom deserializers for JSON string-keyed maps → numeric-keyed BTreeMaps

fn deserialize_day_map<'de, D>(deserializer: D) -> Result<BTreeMap<Day, Assertion>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: BTreeMap<String, Assertion> = BTreeMap::deserialize(deserializer)?;
    let mut result = BTreeMap::new();
    for (k, v) in string_map {
        let key: Day = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_day_seat_map<'de, D>(deserializer: D) -> Result<BTreeMap<Day, Seat>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: BTreeMap<String, Seat> = BTreeMap::deserialize(deserializer)?;
    let mut result = BTreeMap::new();
    for (k, v) in string_map {
        let key: Day = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_day_seat_vec_map<'de, D>(deserializer: D) -> Result<BTreeMap<Day, Vec<Seat>>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: BTreeMap<String, Vec<Seat>> = BTreeMap::deserialize(deserializer)?;
    let mut result = BTreeMap::new();
    for (k, v) in string_map {
        let key: Day = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_day_vote_map<'de, D>(deserializer: D) -> Result<BTreeMap<Day, Vec<VoteRecord>>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: BTreeMap<String, Vec<VoteRecord>> = BTreeMap::deserialize(deserializer)?;
    let mut result = BTreeMap::new();
    for (k, v) in string_map {
        let key: Day = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_seat_status_map<'de, D>(deserializer: D) -> Result<BTreeMap<Seat, SeatStatus>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: BTreeMap<String, SeatStatus> = BTreeMap::deserialize(deserializer)?;
    let mut result = BTreeMap::new();
    for (k, v) in string_map {
        let key: Seat = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_seat_role_map<'de, D>(deserializer: D) -> Result<BTreeMap<Seat, SystemRole>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: BTreeMap<String, SystemRole> = BTreeMap::deserialize(deserializer)?;
    let mut result = BTreeMap::new();
    for (k, v) in string_map {
        let key: Seat = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_seat_bool_map<'de, D>(deserializer: D) -> Result<BTreeMap<Seat, bool>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: BTreeMap<String, bool> = BTreeMap::deserialize(deserializer)?;
    let mut result = BTreeMap::new();
    for (k, v) in string_map {
        let key: Seat = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_optional_day_assertion_vec_map<'de, D>(
    deserializer: D,
) -> Result<Option<BTreeMap<Day, Vec<Assertion>>>, D::Error>
where
    D: Deserializer<'de>,
{
    let opt: Option<BTreeMap<String, Vec<Assertion>>> = Option::deserialize(deserializer)?;
    match opt {
        None => Ok(None),
        Some(string_map) => {
            let mut result = BTreeMap::new();
            for (k, v) in string_map {
                let key: Day = k.parse().map_err(serde::de::Error::custom)?;
                result.insert(key, v);
            }
            Ok(Some(result))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_role_bit_indices_are_correct() {
        assert_eq!(SystemRole::Villager.bit(), 0b000000000001);
        assert_eq!(SystemRole::Seer.bit(), 0b000000000010);
        assert_eq!(SystemRole::Medium.bit(), 0b000000000100);
        assert_eq!(SystemRole::Bodyguard.bit(), 0b000000001000);
        assert_eq!(SystemRole::Mason.bit(), 0b000000010000);
        assert_eq!(SystemRole::Nekomata.bit(), 0b000000100000);
        assert_eq!(SystemRole::Werewolf.bit(), 0b000001000000);
        assert_eq!(SystemRole::Possessed.bit(), 0b000010000000);
        assert_eq!(SystemRole::Fanatic.bit(), 0b000100000000);
        assert_eq!(SystemRole::Werehamster.bit(), 0b001000000000);
        assert_eq!(SystemRole::Immoralist.bit(), 0b010000000000);
        assert_eq!(SystemRole::Paparazzi.bit(), 0b100000000000);
    }

    #[test]
    fn system_role_roundtrip_serde() {
        for role in SystemRole::ALL {
            let json = serde_json::to_string(&role).unwrap();
            let back: SystemRole = serde_json::from_str(&json).unwrap();
            assert_eq!(role, back);
        }
    }

    #[test]
    fn cause_of_death_serde() {
        let cod = CauseOfDeath::CursedByKilledNekomata;
        let json = serde_json::to_string(&cod).unwrap();
        assert_eq!(json, "\"cursed_by_killed_nekomata\"");
        let back: CauseOfDeath = serde_json::from_str(&json).unwrap();
        assert_eq!(cod, back);
    }

    #[test]
    fn from_bit_index_roundtrip() {
        for role in SystemRole::ALL {
            assert_eq!(SystemRole::from_bit_index(role.bit_index()), Some(role));
        }
        assert_eq!(SystemRole::from_bit_index(12), None);
    }
}
