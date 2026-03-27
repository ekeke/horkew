use serde::{Deserialize, Serialize, Deserializer};
use std::collections::HashMap;
use std::fmt;

pub type Seat = u32;
pub type Day = i32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
}

impl SystemRole {
    pub const ALL: [SystemRole; 11] = [
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
            _ => None,
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
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CauseOfDeath {
    Execution,
    NightKill,
    FollowExecutedHamster,
    FollowKilledHamster,
    CursedByExecutedNekomata,
    CursedByKilledNekomata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VillageResult {
    WerewolfWon,
    VillagerWon,
    WerehamsterWon,
    Draw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
    pub assertions: HashMap<Day, Assertion>,
    #[serde(deserialize_with = "deserialize_day_seat_map")]
    pub actions: HashMap<Day, Seat>,
    #[serde(deserialize_with = "deserialize_day_seat_map")]
    pub forecasts: HashMap<Day, Seat>,
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
    pub actions: HashMap<Day, Seat>,
    #[serde(deserialize_with = "deserialize_day_map")]
    pub assertions: HashMap<Day, Assertion>,
    #[serde(deserialize_with = "deserialize_day_seat_map")]
    pub forecasts: HashMap<Day, Seat>,
    #[serde(rename = "noCoOpportunity")]
    pub no_co_opportunity: Option<bool>,
    #[serde(rename = "previousAssertions", default, deserialize_with = "deserialize_optional_day_assertion_vec_map")]
    pub previous_assertions: Option<HashMap<Day, Vec<Assertion>>>,
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
    pub statuses: HashMap<Seat, SeatStatus>,
    #[serde(deserialize_with = "deserialize_day_seat_vec_map")]
    pub executions: HashMap<Day, Vec<Seat>>,
    #[serde(deserialize_with = "deserialize_day_seat_vec_map")]
    pub kills: HashMap<Day, Vec<Seat>>,
    #[serde(rename = "voteHistory", deserialize_with = "deserialize_day_vote_map")]
    pub vote_history: HashMap<Day, Vec<VoteRecord>>,
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
    pub assumptions: HashMap<Seat, SystemRole>,
    #[serde(rename = "wolfPairDenyals", default)]
    pub wolf_pair_denyals: Vec<(Seat, Seat)>,
    #[serde(rename = "hocusPocus", deserialize_with = "deserialize_seat_bool_map", default)]
    pub hocus_pocus: HashMap<Seat, bool>,
    #[serde(default)]
    pub id: u32,
    #[serde(default = "default_batches")]
    pub batches: u32,
    #[serde(default)]
    pub batch: u32,
}

fn default_batches() -> u32 {
    1
}

// Custom deserializers for JSON string-keyed maps → numeric-keyed HashMaps

fn deserialize_day_map<'de, D>(deserializer: D) -> Result<HashMap<Day, Assertion>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: HashMap<String, Assertion> = HashMap::deserialize(deserializer)?;
    let mut result = HashMap::new();
    for (k, v) in string_map {
        let key: Day = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_day_seat_map<'de, D>(deserializer: D) -> Result<HashMap<Day, Seat>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: HashMap<String, Seat> = HashMap::deserialize(deserializer)?;
    let mut result = HashMap::new();
    for (k, v) in string_map {
        let key: Day = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_day_seat_vec_map<'de, D>(deserializer: D) -> Result<HashMap<Day, Vec<Seat>>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: HashMap<String, Vec<Seat>> = HashMap::deserialize(deserializer)?;
    let mut result = HashMap::new();
    for (k, v) in string_map {
        let key: Day = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_day_vote_map<'de, D>(deserializer: D) -> Result<HashMap<Day, Vec<VoteRecord>>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: HashMap<String, Vec<VoteRecord>> = HashMap::deserialize(deserializer)?;
    let mut result = HashMap::new();
    for (k, v) in string_map {
        let key: Day = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_seat_status_map<'de, D>(deserializer: D) -> Result<HashMap<Seat, SeatStatus>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: HashMap<String, SeatStatus> = HashMap::deserialize(deserializer)?;
    let mut result = HashMap::new();
    for (k, v) in string_map {
        let key: Seat = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_seat_role_map<'de, D>(deserializer: D) -> Result<HashMap<Seat, SystemRole>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: HashMap<String, SystemRole> = HashMap::deserialize(deserializer)?;
    let mut result = HashMap::new();
    for (k, v) in string_map {
        let key: Seat = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_seat_bool_map<'de, D>(deserializer: D) -> Result<HashMap<Seat, bool>, D::Error>
where
    D: Deserializer<'de>,
{
    let string_map: HashMap<String, bool> = HashMap::deserialize(deserializer)?;
    let mut result = HashMap::new();
    for (k, v) in string_map {
        let key: Seat = k.parse().map_err(serde::de::Error::custom)?;
        result.insert(key, v);
    }
    Ok(result)
}

fn deserialize_optional_day_assertion_vec_map<'de, D>(
    deserializer: D,
) -> Result<Option<HashMap<Day, Vec<Assertion>>>, D::Error>
where
    D: Deserializer<'de>,
{
    let opt: Option<HashMap<String, Vec<Assertion>>> = Option::deserialize(deserializer)?;
    match opt {
        None => Ok(None),
        Some(string_map) => {
            let mut result = HashMap::new();
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
        assert_eq!(SystemRole::Villager.bit(), 0b00000000001);
        assert_eq!(SystemRole::Seer.bit(), 0b00000000010);
        assert_eq!(SystemRole::Medium.bit(), 0b00000000100);
        assert_eq!(SystemRole::Bodyguard.bit(), 0b00000001000);
        assert_eq!(SystemRole::Mason.bit(), 0b00000010000);
        assert_eq!(SystemRole::Nekomata.bit(), 0b00000100000);
        assert_eq!(SystemRole::Werewolf.bit(), 0b00001000000);
        assert_eq!(SystemRole::Possessed.bit(), 0b00010000000);
        assert_eq!(SystemRole::Fanatic.bit(), 0b00100000000);
        assert_eq!(SystemRole::Werehamster.bit(), 0b01000000000);
        assert_eq!(SystemRole::Immoralist.bit(), 0b10000000000);
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
        assert_eq!(SystemRole::from_bit_index(11), None);
    }
}
