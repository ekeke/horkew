/**
 * Huginn シナリオカタログ.
 *
 * 各 Scenario は EnvConfig と、学習目標・役割メタデータをセットで保持する.
 * 引き分け (tie) / 連合必須シナリオに絞って収録.
 */

import type { EnvConfig } from './abstract-env.ts'

export type RoleDescription = {
  seat: number
  /** 人狼対応の呼称 (例: '村1', '狼', '狐') */
  label: string
  /** 'learning' | 'bot' */
  kind: 'learning' | 'bot'
  /** 所属陣営 (例: 'village', 'werewolf', 'fox') */
  team: string
  /** 勝利条件 (人狼対応) */
  winCondition: string
  /** 1 ターン短期最善の投票先 (説明用) */
  suggestedVoteTarget: string
  /** この seat が他 seat について確定で知っている情報のタグ配列.
   *  値は team 名 ('village'/'werewolf'/'fox') や label 名 ('狼'/'信'/'狐') を含められる.
   *  例: { 3: ['werewolf', '狼'] } = seat3 が werewolf 陣営の狼であると知っている. */
  knowledge: Record<number, string[]>
}

export type ScenarioAnalysis = {
  N: number
  learningAgentCount: number
  botAgentCount: number
  /** 過半数ライン (N/2 + 1 切り上げ) */
  majority: number
  /** 学習 agent 全員が完全合意した場合の期待勝率 */
  expectedWinRateOnFullCoordination: number
}

/** 学習 agent の行動パターンとその結果 */
export type OutcomePattern = {
  /** パターンの短いラベル (例: '完全合意', '非合意') */
  label: string
  /** 票の集まり方 (例: 'bot X: 3, learning 最若: 1') */
  voteTally: string
  /** 吊られる seat と勝敗結果 */
  result: string
  /** 学習側の勝率 (0-1). 勝率とは「学習側の primary を含む seat が吊られる確率」 */
  learnerWinRate: number
}

export type Scenario = {
  name: string
  description: string
  learningObjective: string
  envConfig: EnvConfig
  analysis: ScenarioAnalysis
  roles: RoleDescription[]
  /** 学習 agent の行動パターン別 想定結果 */
  outcomes: OutcomePattern[]
}

// ============================================================
// Tier 0: 最小構成 (pretrain 用途)
// ============================================================

/**
 * 2 学習 agent (村村) vs 2 bot block (狼信).
 *
 * 狼と信 (狂信者) は同じ陣営で村処刑を共通目標とする.
 * 狐不在のため狼陣営は単純 PP を狙えばよく、block で村の片方に票を集中.
 * 学習側 (村) は合意で tie を成立させ 50% 勝率を確保する.
 */
export function pair2v2Block(): Scenario {
  const envConfig: EnvConfig = {
    numAgents: 4,
    agentRoles: [
      'learning',
      'learning',
      { type: 'fixedVote', target: 0 },   // 狼 → s0
      { type: 'fixedVote', target: 0 },   // 狂信者 → s0
    ],
    teams: [[0, 1], [2, 3]],               // 村 team, 狼+狂信 team (村は両者が wolf 陣営と知っている)
    fixedPrimaries: { 0: 2, 1: 2 },        // 村の primary = 狼 s2 (村は狼 seat を知っている)
    randomizeRolesPerGame: false,
    desireCorrelation: 0.7,
    kRounds: 4,
    rewardMode: 'eliminated',
    consensusBonus: 0,
    outcomeRewards: {
      '0':   { reward: 0.0, label: '村 s0 単独吊り → PP成立 (2狼陣営 vs 1村) → 村 loss' },
      '1':   { reward: 0.0, label: '村 s1 単独吊り → PP成立 → 村 loss' },
      '2':   { reward: 1.0, label: '狼 s2 単独吊り → 狼全滅 → 村勝 (狐不在)' },
      '3':   { reward: 0.0, label: '狂信者 s3 単独吊り → 狼生存 → 村勝利条件未達 → 村 loss' },
      '0,1': { reward: 0.0, label: '村 tie → どっち死んでも村 loss' },
      '0,2': { reward: 0.5, label: '村+狼 tie → 50% s2死 (村勝) / 50% s0死 (村 loss)' },
      '0,3': { reward: 0.0, label: '村+狂信 tie → 50% stalemate / 50% 村 loss = 村勝無し' },
      '1,2': { reward: 0.5, label: '村+狼 tie → 50% 村勝 / 50% 村 loss' },
      '1,3': { reward: 0.0, label: '村+狂信 tie → 村勝無し' },
      '2,3': { reward: 0.5, label: '狼+狂信 tie → 50% 村勝 / 50% stalemate (bot 2票が同 seat なので実際は起きない)' },
    },
  }
  return {
    name: 'pair2v2Block',
    description:
      '2 学習 agent (村村) vs 2 bot block (狼 s2 + 狂信者 s3). 両 bot が村 s0 に集中投票する block 構造. ' +
      '狐不在のため村勝利条件は「狼全滅」のみ (狂信者は人間なので生存無関係). ' +
      '**村二人は誰が狼か誰が狂信者かを知っている前提** (fixedPrimaries で s0, s1 の primary を狼 s2 に固定、teams=[[0,1],[2,3]] で狂信を wolf team として認識).',
    learningObjective:
      '村は狼 seat が既知のもと、味方と **狼 s2 に合意投票** → s0-s2 2-way tie 成立 → 50% 村勝期待. ' +
      '狂信者 s3 に投票しても狼生存で村勝無し、単独吊りも村 loss. 既知情報下での集団合意形成が学習の本質.',
    envConfig,
    analysis: {
      N: 4,
      learningAgentCount: 2,
      botAgentCount: 2,
      majority: 3,
      expectedWinRateOnFullCoordination: 0.5,
    },
    roles: [
      { seat: 0, label: '村1', kind: 'learning', team: 'village',  winCondition: '狼全滅 (狐不在)',                    suggestedVoteTarget: '狼 s2 (味方と合意)',                    knowledge: { 2: ['werewolf', '狼'], 3: ['werewolf', '狂信'] } },
      { seat: 1, label: '村2', kind: 'learning', team: 'village',  winCondition: '狼全滅 (狐不在)',                    suggestedVoteTarget: '狼 s2 (味方と合意)',                    knowledge: { 2: ['werewolf', '狼'], 3: ['werewolf', '狂信'] } },
      { seat: 2, label: '狼',  kind: 'bot',      team: 'werewolf', winCondition: 'PP (狼+狂信 ≥ 村)',                  suggestedVoteTarget: '村 s0 集中 (狼陣営の block)',            knowledge: { 3: ['werewolf', '狂信'] } },
      { seat: 3, label: '狂信', kind: 'bot',     team: 'werewolf', winCondition: '狼と同じ (狼陣営勝利)',              suggestedVoteTarget: '村 s0 集中 (狼と同票)',                  knowledge: { 2: ['werewolf', '狼'] } },
    ],
    outcomes: [
      {
        label: '両村が 狼 s2 に合意投票 (最適解)',
        voteTally: 's0: 2 票 (bot×2), s2: 2 票 (村×2)',
        result: '2-way tie (s0, s2) → 50% s2死 (狼全滅 → 村勝) / 50% s0死 (村 loss)',
        learnerWinRate: 0.5,
      },
      {
        label: '両村が 狂信者 s3 に合意投票 (狼誤認)',
        voteTally: 's0: 2 票 (bot×2), s3: 2 票 (村×2)',
        result: '2-way tie (s0, s3) → 50% s3死 (狼生存で stalemate) / 50% s0死 (loss) = 村勝無し',
        learnerWinRate: 0.0,
      },
      {
        label: '村1 と村2 が不一致 (bot1 人ずつ)',
        voteTally: 's0: 2 票 (bot), s2: 1 票, s3: 1 票',
        result: 's0 単独最多 → 村 s0 死 → 村 loss',
        learnerWinRate: 0.0,
      },
    ],
  }
}

/**
 * 2 学習 agent (村村) vs 狼 1 + 狐 1.
 *
 * 狼は「狐が生存している間は勝てない」ため、まず狐を吊る必要がある.
 * 狐は「自分以外が処刑されれば勝ち」のため、誰を狙っても良い (実装上 狼 固定).
 * 結果として敵 2 票は互いに打ち消し合い (狼→狐, 狐→狼), 村は合意すれば確定勝利.
 *
 * 注: 現行 env は randomizeRolesPerGame=true 時に bot の fixed-vote target を
 *    一律 lowestLearnerSeat に書き換える. このシナリオは狼と狐が別 target を
 *    持つ必要があるため seat 位置を固定 (randomize=false).
 */
export function pair2v2Split(): Scenario {
  const envConfig: EnvConfig = {
    numAgents: 4,
    agentRoles: [
      'learning',
      'learning',
      { type: 'fixedVote', target: 3 },   // 狼 → 狐 (狐処刑しないと狼勝てない)
      { type: 'fixedVote', target: 2 },   // 狐 → 狼 (自分以外なら誰でも OK、便宜上 狼)
    ],
    primaryFromBots: true,
    randomizeRolesPerGame: false,
    desireCorrelation: 0.7,
    kRounds: 4,
    rewardMode: 'eliminated',
    consensusBonus: 0,
    outcomeRewards: {
      '0':       { reward: 0.0, label: '村 s0 単独吊り → 村 loss' },
      '1':       { reward: 0.0, label: '村 s1 単独吊り → 村 loss' },
      '2':       { reward: 0.0, label: '狼 s2 単独吊り → 狐勝 → 村 loss' },
      '3':       { reward: 0.0, label: '狐 s3 単独吊り → 狼生存で村勝利条件未達 → 村 loss' },
      '0,1':     { reward: 0.0, label: '村 tie → どっち死んでも村 loss' },
      '0,2':     { reward: 0.0, label: '村+狼 tie → どっち死んでも村 loss' },
      '0,3':     { reward: 0.0, label: '村+狐 tie → どっち死んでも村 loss' },
      '1,2':     { reward: 0.0, label: '村+狼 tie → どっち死んでも村 loss' },
      '1,3':     { reward: 0.0, label: '村+狐 tie → どっち死んでも村 loss' },
      '2,3':     { reward: 1.0, label: '狼狐 tie → 引き分け (唯一の非 loss 帰結)' },
      '0,1,2,3': { reward: 0.0, label: '4-way tie → fox 裏切り想定 (村 loss 扱い)' },
    },
  }
  return {
    name: 'pair2v2Split',
    description:
      '2 学習 agent (村村) vs 狼 1 + 狐 1. 狼は「狐非生存」を勝利条件に含むため狐を吊る必要がある. ' +
      '狐は「自分以外の誰かが処刑」で勝利. 両 bot が互いに投票し、敵票は打ち消し合う. ' +
      '村は合意すれば単独最多 3 票で確定勝利. 現行 env の制約で seat 位置固定.',
    learningObjective:
      '味方 1 人と個別 primary を擦り合わせて bot (狼 or 狐) の一方に票を集中させる. ' +
      '合意すれば確定勝利 (100%), 非合意なら 4-way tie で 50%.',
    envConfig,
    analysis: {
      N: 4,
      learningAgentCount: 2,
      botAgentCount: 2,
      majority: 3,
      expectedWinRateOnFullCoordination: 1.0,
    },
    roles: [
      { seat: 0, label: '村1', kind: 'learning', team: 'village',  winCondition: '狼全滅 かつ 狐非生存',              suggestedVoteTarget: '敵 (狼 or 狐) の一方、味方と合意',      knowledge: {} },
      { seat: 1, label: '村2', kind: 'learning', team: 'village',  winCondition: '狼全滅 かつ 狐非生存',              suggestedVoteTarget: '敵 (狼 or 狐) の一方、味方と合意',      knowledge: {} },
      { seat: 2, label: '狼',  kind: 'bot',      team: 'werewolf', winCondition: 'PP (狼 ≥ 対抗) かつ 狐非生存',      suggestedVoteTarget: '狐 (seat3) — 狐処刑しないと狼勝てない', knowledge: {} },
      { seat: 3, label: '狐',  kind: 'bot',      team: 'fox',      winCondition: '自分以外の誰かが処刑',              suggestedVoteTarget: '自分以外なら誰でも良い (実装: 狼 seat2)', knowledge: {} },
    ],
    outcomes: [
      {
        label: '両村→seat2 狙い (狼を吊る)',
        voteTally: 'seat2: 3 票 (村1 + 村2 + 狐), seat3: 1 票 (狼)',
        result: 'seat2 (狼) 単独最多 → 確定勝利',
        learnerWinRate: 1.0,
      },
      {
        label: '両村→seat3 狙い (狐を吊る)',
        voteTally: 'seat2: 1 票 (狐), seat3: 3 票 (村1 + 村2 + 狼)',
        result: 'seat3 (狐) 単独最多 → 確定勝利',
        learnerWinRate: 1.0,
      },
      {
        label: '村1→seat2, 村2→seat3 (分散 A)',
        voteTally: 'seat2: 2 票 (村1 + 狐), seat3: 2 票 (村2 + 狼)',
        result: '2-way tie → 50% で学習側勝利',
        learnerWinRate: 0.5,
      },
      {
        label: '村1→seat3, 村2→seat2 (分散 B)',
        voteTally: 'seat2: 2 票 (村2 + 狐), seat3: 2 票 (村1 + 狼)',
        result: '2-way tie → 50% で学習側勝利',
        learnerWinRate: 0.5,
      },
    ],
  }
}

/**
 * 3 学習 agent (村×3) vs 2 bot block (狼 s3 + 狂信者 s4).
 *
 * 村は **味方 (他 learner) のみ既知**. 敵 2 体 (s3 と s4) のどちらが狼かは区別不能.
 * primaryFromBots=true で各村の primary を独立ランダム (s3 or s4) に → 敵の区別不能を表現.
 * 他 learner は desire で LOW → 味方識別可能.
 *
 * 単独最多 3 票 > bot 2 票で確定吊り可能. 狼を選べば村勝、狂信者を選べば stalemate.
 * 村に情報がない以上、期待 win rate は coordination 次第で最大 0.5 (運ゲー).
 */
export function trio3v2Block(): Scenario {
  const envConfig: EnvConfig = {
    numAgents: 5,
    agentRoles: [
      'learning',
      'learning',
      'learning',
      { type: 'fixedVote', target: 0 },   // 狼 → s0
      { type: 'fixedVote', target: 0 },   // 狂信者 → s0
    ],
    primaryFromBots: true,
    randomizeRolesPerGame: false,
    desireCorrelation: 0.7,
    kRounds: 4,
    rewardMode: 'eliminated',
    consensusBonus: 0,
    outcomeRewards: {
      '3':   { reward: 1.0, label: 's3 単独吊り成功 → 意思統一合格' },
      '4':   { reward: 1.0, label: 's4 単独吊り成功 → 意思統一合格' },
      '0':   { reward: 0.0, label: '村 s0 吊り → 失格' },
      '1':   { reward: 0.0, label: '村 s1 吊り → 失格' },
      '2':   { reward: 0.0, label: '村 s2 吊り → 失格' },
      '0,1': { reward: 0.0, label: '村 tie → 失格' },
      '0,2': { reward: 0.0, label: '村 tie → 失格' },
      '1,2': { reward: 0.0, label: '村 tie → 失格' },
      '0,3': { reward: 0.0, label: '村+敵 tie → 意思統一不完全 → 失格' },
      '1,3': { reward: 0.0, label: '村+敵 tie → 意思統一不完全 → 失格' },
      '2,3': { reward: 0.0, label: '村+敵 tie → 意思統一不完全 → 失格' },
      '0,4': { reward: 0.0, label: '村+敵 tie → 意思統一不完全 → 失格' },
      '1,4': { reward: 0.0, label: '村+敵 tie → 意思統一不完全 → 失格' },
      '2,4': { reward: 0.0, label: '村+敵 tie → 意思統一不完全 → 失格' },
      '3,4': { reward: 0.0, label: '敵 tie → 意思統一不完全 → 失格 (bot 票が s0 集中で達成不可)' },
    },
  }
  return {
    name: 'trio3v2Block',
    description:
      '3 学習 agent (村×3) vs 2 bot block (狼 s3 + 狂信者 s4). 両 bot が村 s0 に集中投票. ' +
      '**村は味方 3 名のみ既知** (desire で他 learner を LOW 識別). ' +
      '敵 2 体の区別不能 (primaryFromBots で s3/s4 をランダム独立 primary に割当). ' +
      '狐不在のため村勝条件は狼全滅のみ.',
    learningObjective:
      '味方既知かつ敵区別不能な状況で 3 村が協調. 全員一致で敵 bot 1 体に集中投票すれば単独最多 (3>2) で確定吊り = 合格. ' +
      's3 / s4 どちらを吊っても同じく合格 (意思統一自体が目標). それ以外はすべて失格. ' +
      'desire は非情報的 signal なので、通信 or convention で 1 体に集約する.',
    envConfig,
    analysis: {
      N: 5,
      learningAgentCount: 3,
      botAgentCount: 2,
      majority: 3,
      expectedWinRateOnFullCoordination: 0.5,
    },
    roles: [
      { seat: 0, label: '村1', kind: 'learning', team: 'village',  winCondition: '狼全滅 (狐不在)',                    suggestedVoteTarget: '敵 bot 1 体を味方と合意',           knowledge: { 1: ['village'], 2: ['village'] } },
      { seat: 1, label: '村2', kind: 'learning', team: 'village',  winCondition: '狼全滅 (狐不在)',                    suggestedVoteTarget: '敵 bot 1 体を味方と合意',           knowledge: { 0: ['village'], 2: ['village'] } },
      { seat: 2, label: '村3', kind: 'learning', team: 'village',  winCondition: '狼全滅 (狐不在)',                    suggestedVoteTarget: '敵 bot 1 体を味方と合意',           knowledge: { 0: ['village'], 1: ['village'] } },
      { seat: 3, label: '狼',  kind: 'bot',      team: 'werewolf', winCondition: 'PP (狼+狂信 ≥ 村)',                  suggestedVoteTarget: '村 s0 集中 (狼陣営の block)',       knowledge: { 4: ['werewolf', '狂信'] } },
      { seat: 4, label: '狂信', kind: 'bot',     team: 'werewolf', winCondition: '狼と同じ (狼陣営勝利)',              suggestedVoteTarget: '村 s0 集中 (狼と同票)',             knowledge: { 3: ['werewolf', '狼'] } },
    ],
    outcomes: [
      {
        label: '3村全員が s3 に合意投票',
        voteTally: 's0: 2 票 (bot), s3: 3 票 (村×3)',
        result: 's3 単独吊り → 意思統一合格',
        learnerWinRate: 1.0,
      },
      {
        label: '3村全員が s4 に合意投票',
        voteTally: 's0: 2 票 (bot), s4: 3 票 (村×3)',
        result: 's4 単独吊り → 意思統一合格',
        learnerWinRate: 1.0,
      },
      {
        label: '村票が 1-2 で割れる (意思統一失敗)',
        voteTally: 's0: 2 票 (bot), s3: 2 票, s4: 1 票 等',
        result: '村+敵 tie または s0 単独吊り → 失格',
        learnerWinRate: 0.0,
      },
    ],
  }
}

// ============================================================
// Catalog
// ============================================================

export const catalog: Record<string, () => Scenario> = {
  pair2v2Block,
  pair2v2Split,
  trio3v2Block,
}
