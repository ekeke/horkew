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
    randomizeRolesPerGame: true,
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
    randomizeRolesPerGame: true,
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
      '村は合意すれば単独最多 3 票で確定勝利.',
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
      // 狼: unanimous offer(I:L0, Y:L0) を broadcast. 村チームと同形の会話を出し、観測側 (学習 agent) の
      //    commit count feature に狼陣営の意思統一信号が流入する.
      { type: 'offerer', primary: 0, acceptable: [0, 1, 2], mode: 'unanimous' },
      // 狂信: 狼の offer(Y:L0) を受けて commit(L0). 最終投票も L0 = 最若 learner.
      //    学習 agent から見ると「敵 2 票が揃って L0 に commit」が features[6] に載る.
      { type: 'eagerCommitter', primary: 0, acceptable: [0, 1, 2] },
    ],
    primaryFromBots: true,
    randomizeRolesPerGame: true,
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

/**
 * 実演デモ (学習なし): 2 bot 村 (offerer + eagerCommitter) vs 狼 + 狐.
 *
 * pair2v2Split と同じ構造だが、2 村を学習 agent ではなくスクリプトボットに置き換えた.
 * 論理 seat:
 *   s0 = offerer 村 (primary=s2 狼, acceptable={s2,s3}) — 毎 round offer(iVote=s2, youVote=s3)
 *   s1 = eagerCommitter 村 (primary=s3 狐, acceptable={s2,s3}) — offer.youVote=s3 を見て commit(s3)
 *   s2 = 狼 (fixedVote→s3)
 *   s3 = 狐 (fixedVote→s2)
 *
 * 期待帰結: offerer→s2, committer→s3, 狼→s3, 狐→s2 で 2-way tie (s2,s3) = 村勝確率 50%.
 * 学習 agent なしなので reward 集計は 0、プロトコルの動作検証のみ.
 */
export function pair2v2SplitMentor(): Scenario {
  const envConfig: EnvConfig = {
    numAgents: 4,
    agentRoles: [
      { type: 'offerer', primary: 2, acceptable: [2, 3] },
      { type: 'eagerCommitter', primary: 3, acceptable: [2, 3] },
      { type: 'fixedVote', target: 3 },
      { type: 'fixedVote', target: 2 },
    ],
    randomizeRolesPerGame: true,
    desireCorrelation: 0.7,
    kRounds: 4,
    rewardMode: 'eliminated',
    consensusBonus: 0,
    outcomeRewards: {
      '2,3': { reward: 1.0, label: '狼狐 tie → 引き分け (実演プロトコル成功)' },
    },
  }
  return {
    name: 'pair2v2SplitMentor',
    description:
      '実演デモ: 2 bot 村 (offerer + eagerCommitter) vs 狼+狐. 学習 agent なし. offer→commit プロトコルの動作検証用.',
    learningObjective:
      '(学習なし) bot プロトコル検証: offerer が offer(iVote=s2, youVote=s3) を出す → eagerCommitter が commit(s3) → 分散投票で s2-s3 tie 成立.',
    envConfig,
    analysis: {
      N: 4,
      learningAgentCount: 0,
      botAgentCount: 4,
      majority: 3,
      expectedWinRateOnFullCoordination: 0,   // no learners
    },
    roles: [
      { seat: 0, label: '村-offer', kind: 'bot', team: 'village',  winCondition: '狼全滅 かつ 狐非生存',           suggestedVoteTarget: '狼 s2 (primary)',   knowledge: { 2: ['werewolf', '狼'], 3: ['fox', '狐'] } },
      { seat: 1, label: '村-commit', kind: 'bot', team: 'village',  winCondition: '狼全滅 かつ 狐非生存',           suggestedVoteTarget: '狐 s3 (primary)',   knowledge: { 2: ['werewolf', '狼'], 3: ['fox', '狐'] } },
      { seat: 2, label: '狼',      kind: 'bot', team: 'werewolf', winCondition: 'PP (狼 ≥ 対抗) かつ 狐非生存', suggestedVoteTarget: '狐 (seat3)',          knowledge: {} },
      { seat: 3, label: '狐',      kind: 'bot', team: 'fox',      winCondition: '自分以外の誰かが処刑',           suggestedVoteTarget: '狼 (seat2)',          knowledge: {} },
    ],
    outcomes: [
      {
        label: 'プロトコル完遂 (想定帰結)',
        voteTally: 's2: 2 (村-offer + 狐), s3: 2 (村-commit + 狼)',
        result: '2-way tie (s2, s3) → 50% 村勝',
        learnerWinRate: 0.5,
      },
    ],
  }
}

/**
 * 学習あり curriculum: 2 learner 村 + 1 mentor 村 (unanimous offerer) vs 狼 + 狂信.
 *
 * trio3v2Block の村 3 人のうち 1 人を mentor 実演ボットに置換. mentor は毎 round
 * offer(iVote=s3 狼, youVote=s3) を broadcast. 学習 agent 2 人は自分の primary が
 * mentor 推奨 (狼 s3) と一致するか食い違うかに応じて振る舞いを学ぶ必要がある:
 *
 *   - primary=s3 の learner は自然に mentor に同調 → 全員 s3 に投票で勝利
 *   - primary=s4 の learner は自分の primary を捨てて mentor broadcast に乗り換え必須
 *
 * 狼 s3 / 狂信 s4 は trio3v2Block と同じ offerer + committer プロトコルで L0 集中 broadcast を
 * 出すので、学習側は「mentor broadcast (s3 狙い)」と「敵 broadcast (L0 狙い)」を識別し、
 * desire と offer count の両方を参照して判定する必要がある.
 *
 * 理論最大: 100% (全 learner が mentor に同調、狼 s3 単独吊り → outcome '3').
 * 情報なし baseline: 学習 2 人が独立ランダム → 一致確率 0.5 → 50%.
 */
export function trio3v2BlockMentored(): Scenario {
  const envConfig: EnvConfig = {
    numAgents: 5,
    agentRoles: [
      'learning',
      'learning',
      { type: 'offerer', primary: 3, acceptable: [3], mode: 'unanimous' },  // mentor 村: 狼に合意しよう
      { type: 'offerer', primary: 0, acceptable: [0, 1, 2], mode: 'unanimous' },  // 狼: L0 に合意しよう
      { type: 'eagerCommitter', primary: 0, acceptable: [0, 1, 2] },  // 狂信: 狼 offer に乗る
    ],
    primaryCandidates: [3, 4],  // 学習 agent の primary は 狼/狂信 から独立ランダム
    teams: [[0, 1, 2], [3, 4]], // 村チーム (learner 2 + mentor) vs 狼陣営. desire で teammate/primary 区別するために必須
    randomizeRolesPerGame: true,
    desireCorrelation: 0.7,
    kRounds: 4,
    rewardMode: 'eliminated',
    consensusBonus: 0,
    outcomeRewards: {
      '3': { reward: 1.0, label: '狼 s3 単独吊り成功 — mentor 同調合格' },
      '4': { reward: 1.0, label: '狂信 s4 単独吊り — (可) mentor 無視だが勝利' },
      '0': { reward: 0.0, label: '村 s0 吊り — 敵 broadcast に乗せられた失格' },
      '1': { reward: 0.0, label: '村 s1 吊り — 失格' },
      '2': { reward: 0.0, label: '村 mentor s2 吊り — 失格' },
      '0,1': { reward: 0.0, label: '村 tie — 失格' },
      '0,2': { reward: 0.0, label: '村 tie — 失格' },
      '1,2': { reward: 0.0, label: '村 tie — 失格' },
      '0,3': { reward: 0.0, label: '村+敵 tie — 意思統一不完全' },
      '1,3': { reward: 0.0, label: '村+敵 tie — 意思統一不完全' },
      '2,3': { reward: 0.0, label: '村+敵 tie — 意思統一不完全' },
      '0,4': { reward: 0.0, label: '村+敵 tie — 意思統一不完全' },
      '1,4': { reward: 0.0, label: '村+敵 tie — 意思統一不完全' },
      '2,4': { reward: 0.0, label: '村+敵 tie — 意思統一不完全' },
      '3,4': { reward: 0.0, label: '敵 tie — 意思統一不完全' },
    },
  }
  return {
    name: 'trio3v2BlockMentored',
    description:
      '2 学習 agent 村 + 1 mentor 村 (unanimous offerer, 狼 s3 を broadcast) vs 狼 s3 (unanimous offerer, L0 を broadcast) + 狂信 s4 (eagerCommitter). ' +
      '学習 agent は自分の primary ではなく mentor broadcast に乗る必要がある. 敵の L0 broadcast とは desire で識別する.',
    learningObjective:
      '学習: mentor の offer(s3,s3) を読み取って自分の primary (s3 or s4 ランダム) が食い違う時に譲歩して s3 に投票. ' +
      '敵の L0 broadcast は desire LOW (teammate) で識別し無視.',
    envConfig,
    analysis: {
      N: 5,
      learningAgentCount: 2,
      botAgentCount: 3,
      majority: 3,
      expectedWinRateOnFullCoordination: 1.0,
    },
    roles: [
      { seat: 0, label: '村1',   kind: 'learning', team: 'village',  winCondition: '狼全滅',                 suggestedVoteTarget: 'mentor の broadcast 狼 s3',     knowledge: { 2: ['village', 'mentor'] } },
      { seat: 1, label: '村2',   kind: 'learning', team: 'village',  winCondition: '狼全滅',                 suggestedVoteTarget: 'mentor の broadcast 狼 s3',     knowledge: { 2: ['village', 'mentor'] } },
      { seat: 2, label: 'mentor', kind: 'bot',    team: 'village',  winCondition: '狼全滅',                 suggestedVoteTarget: '狼 s3 unanimous broadcast',      knowledge: { 3: ['werewolf', '狼'] } },
      { seat: 3, label: '狼',    kind: 'bot',     team: 'werewolf', winCondition: 'PP',                    suggestedVoteTarget: 'L0 unanimous broadcast',         knowledge: { 4: ['werewolf', '狂信'] } },
      { seat: 4, label: '狂信',  kind: 'bot',     team: 'werewolf', winCondition: '狼勝利',                suggestedVoteTarget: '狼 broadcast に乗る',             knowledge: { 3: ['werewolf', '狼'] } },
    ],
    outcomes: [
      {
        label: '学習 2 村が mentor に同調',
        voteTally: 's0: 2 (bot), s3: 3 (村×3)',
        result: 's3 単独吊り → 狼全滅',
        learnerWinRate: 1.0,
      },
    ],
  }
}

/**
 * 実演デモ (学習なし): 3 bot 村 (unanimous offerer + 2 eagerCommitter) vs 狼 + 狂信.
 *
 * trio3v2Block と同じ構造だが、3 村をスクリプトボットに置換.
 * 論理 seat:
 *   s0 = unanimous offerer 村 (primary=s3 狼, mode=unanimous) — 毎 round offer(iVote=s3, youVote=s3)
 *   s1 = eagerCommitter 村 (primary=s4, acceptable={s3,s4}) — offer.youVote=s3 を見て commit(s3), 自分の primary を譲る
 *   s2 = eagerCommitter 村 (primary=s3, acceptable={s3,s4}) — 同じく commit(s3)
 *   s3 = 狼 (fixedVote→s0)
 *   s4 = 狂信 (fixedVote→s0)
 *
 * 期待帰結: 全 3 村 s3 に一致投票、bot 2 票は s0、tally s0:2 s3:3 → s3 単独吊り → '3' 成功.
 * s1 の primary は本来 s4 だが acceptable に s3 を含むので「offer broadcast に乗って譲る」動作を検証する.
 */
export function trio3v2Mentor(): Scenario {
  const envConfig: EnvConfig = {
    numAgents: 5,
    agentRoles: [
      { type: 'offerer', primary: 3, acceptable: [3, 4], mode: 'unanimous' },
      { type: 'eagerCommitter', primary: 4, acceptable: [3, 4] },
      { type: 'eagerCommitter', primary: 3, acceptable: [3, 4] },
      { type: 'fixedVote', target: 0 },
      { type: 'fixedVote', target: 0 },
    ],
    randomizeRolesPerGame: true,
    desireCorrelation: 0.7,
    kRounds: 4,
    rewardMode: 'eliminated',
    consensusBonus: 0,
    outcomeRewards: {
      '3': { reward: 1.0, label: '3 人単独合意 (狼 s3 吊り) — unanimous broadcast 成功' },
      '4': { reward: 1.0, label: '3 人単独合意 (狂信 s4 吊り)' },
    },
  }
  return {
    name: 'trio3v2Mentor',
    description:
      '実演デモ: 3 bot 村 (unanimous offerer + 2 eagerCommitter) vs 狼+狂信. ' +
      'unanimous offer(iVote=X, youVote=X) の broadcast protocol を検証. ' +
      '1 名の committer は primary が s4 だが acceptable に s3 を含むため、offerer の s3 broadcast に乗り換える (= 譲歩).',
    learningObjective:
      '(学習なし) bot プロトコル検証: unanimous offerer が offer(3,3) を broadcast → committer 2 名が即 commit(3) → 全 3 村 s3 集中投票 → 狼単独吊り成功.',
    envConfig,
    analysis: {
      N: 5,
      learningAgentCount: 0,
      botAgentCount: 5,
      majority: 3,
      expectedWinRateOnFullCoordination: 0,   // no learners
    },
    roles: [
      { seat: 0, label: '村-offer',   kind: 'bot', team: 'village',  winCondition: '狼全滅',                              suggestedVoteTarget: '狼 s3 を broadcast',     knowledge: { 3: ['werewolf', '狼'], 4: ['werewolf', '狂信'] } },
      { seat: 1, label: '村-commit1', kind: 'bot', team: 'village',  winCondition: '狼全滅',                              suggestedVoteTarget: 'offer に乗る (譲歩)',       knowledge: { 3: ['werewolf'], 4: ['werewolf'] } },
      { seat: 2, label: '村-commit2', kind: 'bot', team: 'village',  winCondition: '狼全滅',                              suggestedVoteTarget: 'offer に乗る',              knowledge: { 3: ['werewolf'], 4: ['werewolf'] } },
      { seat: 3, label: '狼',         kind: 'bot', team: 'werewolf', winCondition: 'PP',                                 suggestedVoteTarget: 's0 集中',                  knowledge: { 4: ['werewolf', '狂信'] } },
      { seat: 4, label: '狂信',       kind: 'bot', team: 'werewolf', winCondition: '狼勝利',                              suggestedVoteTarget: 's0 集中',                  knowledge: { 3: ['werewolf', '狼'] } },
    ],
    outcomes: [
      {
        label: 'プロトコル完遂 (想定帰結)',
        voteTally: 's0: 2 (bot), s3: 3 (村×3)',
        result: 's3 単独吊り → 狼全滅',
        learnerWinRate: 1.0,
      },
    ],
  }
}

// ============================================================
// Tier 1: 指定進行 (designatedTargets)
// ============================================================

/**
 * 単独指定 baseline: 2 学習 agent (村村) vs 狼+狂信 block、designatedTargets=[s2] (狼のみ).
 *
 * pair2v2Block と同じ票構造だが primary は {s2, s3} からランダム (primaryFromBots).
 * primary=s2 の learner は指定と整合、primary=s3 の learner は指定と衝突.
 * DESIGNATION_VIOLATION_PENALTY (-0.2) が primary HIGH (+0.10) より大きいため、
 * 指定遵守 (vote s2) が常に dominant. 「指定絶対服従」の最小検証シナリオ.
 *
 * 理論最大: 両 learner が s2 投票 → s0:2 vs s2:2 tie → 50% 村勝 (outcome '0,2' reward=0.5).
 */
export function pair2designatedSingle(): Scenario {
  const envConfig: EnvConfig = {
    numAgents: 4,
    agentRoles: [
      'learning',
      'learning',
      { type: 'fixedVote', target: 0 },   // 狼 → s0 block
      { type: 'fixedVote', target: 0 },   // 狂信 → s0 block
    ],
    teams: [[0, 1], [2, 3]],
    primaryFromBots: true,                // primary は {s2, s3} からランダム独立
    designatedTargets: [2],               // 狼 s2 のみ指定
    randomizeRolesPerGame: true,
    desireCorrelation: 0.7,
    kRounds: 4,
    rewardMode: 'eliminated',
    consensusBonus: 0,
    outcomeRewards: {
      '2':   { reward: 1.0, label: '狼 s2 単独吊り → 村勝 (designation follow)' },
      '0,2': { reward: 0.5, label: '村+狼 tie → 50% 村勝' },
      '3':   { reward: 0.0, label: '狂信 s3 吊り → 狼生存で村 loss' },
      '0,3': { reward: 0.0, label: '村+狂信 tie → 村 loss' },
      '0':   { reward: 0.0, label: '村 s0 吊り → 村 loss' },
      '1':   { reward: 0.0, label: '村 s1 吊り → 村 loss' },
      '0,1': { reward: 0.0, label: '村 tie → 村 loss' },
      '1,2': { reward: 0.5, label: '村+狼 tie → 50% 村勝' },
      '1,3': { reward: 0.0, label: '村+狂信 tie → 村 loss' },
      '2,3': { reward: 0.5, label: '狼+狂信 tie (bot 票集中で実際は起きない)' },
    },
  }
  return {
    name: 'pair2designatedSingle',
    description:
      '2 学習 agent (村村) vs 狼 s2 + 狂信 s3 (block→s0). designatedTargets=[s2] の単独指定. ' +
      'primary は {s2, s3} からランダム独立なので 50% で指定と衝突する. ' +
      'ペナルティ -0.2 が primary shaping +0.10 より大きいため、指定遵守が常に最適. ' +
      '「単独指定 = 絶対服従」学習の最小検証.',
    learningObjective:
      '自分の primary が s2 でも s3 でも常に s2 (指定対象) に投票する. ' +
      'primary=s3 の時が真の学習課題: vote s3 (primary) = -0.1 / vote s2 (designation) = +0.05. ' +
      '理論最大 win rate 50% (両 learner が s2 投票時の 0,2 tie).',
    envConfig,
    analysis: {
      N: 4,
      learningAgentCount: 2,
      botAgentCount: 2,
      majority: 3,
      expectedWinRateOnFullCoordination: 0.5,
    },
    roles: [
      { seat: 0, label: '村1', kind: 'learning', team: 'village',  winCondition: '狼全滅 (狐不在)',                    suggestedVoteTarget: '狼 s2 (指定遵守)',                     knowledge: { 2: ['werewolf', '狼'], 3: ['werewolf', '狂信'] } },
      { seat: 1, label: '村2', kind: 'learning', team: 'village',  winCondition: '狼全滅 (狐不在)',                    suggestedVoteTarget: '狼 s2 (指定遵守)',                     knowledge: { 2: ['werewolf', '狼'], 3: ['werewolf', '狂信'] } },
      { seat: 2, label: '狼',  kind: 'bot',      team: 'werewolf', winCondition: 'PP (狼+狂信 ≥ 村)',                  suggestedVoteTarget: '村 s0 block',                           knowledge: { 3: ['werewolf', '狂信'] } },
      { seat: 3, label: '狂信', kind: 'bot',     team: 'werewolf', winCondition: '狼陣営勝利',                        suggestedVoteTarget: '村 s0 block',                           knowledge: { 2: ['werewolf', '狼'] } },
    ],
    outcomes: [
      {
        label: '両村が s2 (指定) に投票',
        voteTally: 's0: 2 (bot), s2: 2 (村)',
        result: '0,2 tie → 50% 村勝 (outcome reward 0.5, ペナルティなし)',
        learnerWinRate: 0.5,
      },
      {
        label: '両村が s3 (primary=s3 だが指定違反)',
        voteTally: 's0: 2 (bot), s3: 2 (村)',
        result: '0,3 tie → 村 loss (reward 0) + 各 -0.2 penalty',
        learnerWinRate: 0.0,
      },
      {
        label: '村1→s2, 村2→s3 (分裂、村2 は指定違反)',
        voteTally: 's0: 2, s2: 1, s3: 1',
        result: 's0 単独吊り → 村 loss, 村2 に -0.2 penalty',
        learnerWinRate: 0.0,
      },
    ],
  }
}

/**
 * ラン指定 (村方): 3 学習 agent (村×3) vs 狼+狂信 block、designatedTargets=[s3, s4] (両 bot).
 *
 * trio3v2Block とほぼ同構成だが、designatedTargets を追加.
 * 村は {s3, s4} 範囲内で自分の primary に従って投票 (primary=s3 なら vote s3). 範囲外 (村同士) は penalty -0.2.
 * 3 learner の primary が独立ランダムなので P(全員一致) = 0.25 → 通信なし理論最大 25% 近辺.
 * 通信 (offer/commit) を使って範囲内で集約できれば 100% に近づく.
 *
 * 「ラン指定の本質」= 範囲内では desire で分岐、範囲外は明示的に penalize. trio3v2Block と同じ
 * タスクだが penalty signal が即時的なので coordination の学習速度が速くなる可能性を検証.
 */
export function trio3designatedRange(): Scenario {
  const envConfig: EnvConfig = {
    numAgents: 5,
    agentRoles: [
      'learning',
      'learning',
      'learning',
      { type: 'fixedVote', target: 0 },   // 狼 → s0 block
      { type: 'fixedVote', target: 0 },   // 狂信 → s0 block
    ],
    primaryFromBots: true,                // primary は {s3, s4} からランダム独立
    designatedTargets: [3, 4],            // ラン指定: 両敵 bot
    randomizeRolesPerGame: true,
    desireCorrelation: 0.7,
    kRounds: 4,
    rewardMode: 'eliminated',
    consensusBonus: 0,
    outcomeRewards: {
      '3':   { reward: 1.0, label: '狼 s3 単独吊り → 村勝' },
      '4':   { reward: 1.0, label: '狂信 s4 単独吊り → 失格 (狼生存) — ただし合意達成で reward' },
      '0':   { reward: 0.0, label: '村 s0 吊り → 村 loss' },
      '1':   { reward: 0.0, label: '村 s1 吊り → 村 loss' },
      '2':   { reward: 0.0, label: '村 s2 吊り → 村 loss' },
      '0,1': { reward: 0.0, label: '村 tie → 村 loss' },
      '0,2': { reward: 0.0, label: '村 tie → 村 loss' },
      '1,2': { reward: 0.0, label: '村 tie → 村 loss' },
      '0,3': { reward: 0.0, label: '村+狼 tie → 合意不完全' },
      '1,3': { reward: 0.0, label: '村+狼 tie → 合意不完全' },
      '2,3': { reward: 0.0, label: '村+狼 tie → 合意不完全' },
      '0,4': { reward: 0.0, label: '村+狂信 tie → 合意不完全' },
      '1,4': { reward: 0.0, label: '村+狂信 tie → 合意不完全' },
      '2,4': { reward: 0.0, label: '村+狂信 tie → 合意不完全' },
      '3,4': { reward: 0.0, label: '敵 tie (bot 票 s0 集中なので起きない)' },
    },
  }
  return {
    name: 'trio3designatedRange',
    description:
      '3 学習 agent (村×3) vs 狼 s3 + 狂信 s4 (block→s0). designatedTargets=[s3, s4] のラン指定. ' +
      'primary は {s3, s4} からランダム独立. 村は範囲内で primary に従って投票、範囲外への誤投票は -0.2. ' +
      'trio3v2Block と同タスクだが指定ペナルティで coordination 学習が加速するかを検証.',
    learningObjective:
      '範囲 {s3, s4} 内で自分の primary で分岐 + 3 learner で合意形成. ' +
      '独立ランダム primary の一致確率は 0.25、通信で単独吊りに導けば 100% 近い. ' +
      '村同士の誤投票は即 -0.2 penalty で弾かれる.',
    envConfig,
    analysis: {
      N: 5,
      learningAgentCount: 3,
      botAgentCount: 2,
      majority: 3,
      expectedWinRateOnFullCoordination: 1.0,
    },
    roles: [
      { seat: 0, label: '村1', kind: 'learning', team: 'village',  winCondition: '狼全滅 (狐不在)',                    suggestedVoteTarget: '範囲 {s3, s4} で primary に従う',     knowledge: { 1: ['village'], 2: ['village'] } },
      { seat: 1, label: '村2', kind: 'learning', team: 'village',  winCondition: '狼全滅 (狐不在)',                    suggestedVoteTarget: '範囲 {s3, s4} で primary に従う',     knowledge: { 0: ['village'], 2: ['village'] } },
      { seat: 2, label: '村3', kind: 'learning', team: 'village',  winCondition: '狼全滅 (狐不在)',                    suggestedVoteTarget: '範囲 {s3, s4} で primary に従う',     knowledge: { 0: ['village'], 1: ['village'] } },
      { seat: 3, label: '狼',  kind: 'bot',      team: 'werewolf', winCondition: 'PP',                                 suggestedVoteTarget: '村 s0 block',                         knowledge: { 4: ['werewolf', '狂信'] } },
      { seat: 4, label: '狂信', kind: 'bot',     team: 'werewolf', winCondition: '狼陣営勝利',                         suggestedVoteTarget: '村 s0 block',                         knowledge: { 3: ['werewolf', '狼'] } },
    ],
    outcomes: [
      {
        label: '3 村全員 s3 合意',
        voteTally: 's0: 2 (bot), s3: 3',
        result: 's3 単独吊り → reward 1.0 each、ペナルティなし',
        learnerWinRate: 1.0,
      },
      {
        label: '3 村全員 s4 合意',
        voteTally: 's0: 2 (bot), s4: 3',
        result: 's4 単独吊り → reward 1.0 each (outcome は狼生存でも合意達成で許容)',
        learnerWinRate: 1.0,
      },
      {
        label: '2-1 split (例 s3×2, s4×1)',
        voteTally: 's0: 2, s3: 2, s4: 1',
        result: '0,3 tie → reward 0、ペナルティなし (範囲内投票)',
        learnerWinRate: 0.0,
      },
      {
        label: '村が自分たち同士に誤投票 (例 s0)',
        voteTally: 's0: 3 (bot+村), s3: ..., s4: ...',
        result: '範囲外投票 learner に -0.2 penalty + outcome 村 loss',
        learnerWinRate: 0.0,
      },
    ],
  }
}

/**
 * 狼陣営 PP 指定無視: 狼 learner が penalty を飲んで PP (power play) を成立させるシナリオ.
 *
 * N=5 構成 (全 bot は fixedVote で静的解析可能に):
 *   s0, s1 = 村 fixedVote bot (target=狼 s2, designation-compliant)
 *   s2, s3 = 狼 learner
 *   s4 = 狂信 fixedVote bot (target=村 s0)
 *
 * teams = [[0, 1], [2, 3, 4]]. designatedTargets=[s2, s3] (村視点で狼).
 * 村 2 票は狼 s2 に集中 (designation 遵守). 狂信 1 票は村 s0 に. 狼 2 票が分かれ所.
 * 狼陣営目線では指定遵守 = 仲間 s2 elim = 陣営敗. defy + coord on s0 = PP 成立 +0.8 each.
 *
 * 狼の学習課題:
 *   1. designation penalty を飲んでも村 seat に投票 (defy)
 *   2. 狂信 fixedVote=s0 に合わせて 2 狼も s0 に投票 (coordinate)
 *   - primary は team-shared でランダム (s0 or s1) だが、狂信が s0 固定なので s0 coordination が dominant
 *
 * reward 算術 (rewardByTeam):
 *   - 指定遵守 (vote s2 or s3): penalty なし、outcome '2' (狼 s2 elim) → team 1 = 0, 陣営敗
 *   - defy 一致 (両狼 s0): outcome '0' → team 1 = 1.0, 各 -0.2 penalty = +0.8 each
 *   - defy 不一致 (1狼 s0, 1狼 s1): 0-s2 tie or miss-coord → team 1 = 0.5, -0.2 each = +0.3 each
 */
export function wolfPPIgnoreDesignation(): Scenario {
  const envConfig: EnvConfig = {
    numAgents: 5,
    agentRoles: [
      { type: 'fixedVote', target: 2 },   // 村 s0: 狼 s2 (designation-compliant)
      { type: 'fixedVote', target: 2 },   // 村 s1: 狼 s2 (designation-compliant)
      'learning',                          // 狼 s2
      'learning',                          // 狼 s3
      { type: 'fixedVote', target: 0 },   // 狂信 s4: 村 s0 (PP 方向に寄せる)
    ],
    teams: [[0, 1], [2, 3, 4]],
    randomizeRolesPerGame: true,
    desireCorrelation: 0.7,
    kRounds: 4,
    rewardMode: 'eliminated',
    consensusBonus: 0,
    designatedTargets: [2, 3],   // 村視点で狼 2 体を指定. 狼 learner には penalty 対象.
    outcomeRewards: {
      '0': { rewardByTeam: { 0: 0.0, 1: 1.0 }, label: '村 s0 吊り → PP 成立 (狼陣営勝利)' },
      '1': { rewardByTeam: { 0: 0.0, 1: 1.0 }, label: '村 s1 吊り → PP 成立 (狼陣営勝利)' },
      '2': { rewardByTeam: { 0: 1.0, 1: 0.0 }, label: '狼 s2 吊り → 村勝利' },
      '3': { rewardByTeam: { 0: 1.0, 1: 0.0 }, label: '狼 s3 吊り → 村勝利' },
      '4': { rewardByTeam: { 0: 0.0, 1: 0.0 }, label: '狂信 s4 吊り → 双方 lose' },
      '0,1': { rewardByTeam: { 0: 0.0, 1: 1.0 }, label: '村村 tie → どちらが死んでも PP 成立' },
      '0,2': { rewardByTeam: { 0: 0.5, 1: 0.5 }, label: '村+狼 tie → 50% で決着' },
      '0,3': { rewardByTeam: { 0: 0.5, 1: 0.5 }, label: '村+狼 tie → 50%' },
      '0,4': { rewardByTeam: { 0: 0.0, 1: 0.5 }, label: '村+狂信 tie → 50% PP' },
      '1,2': { rewardByTeam: { 0: 0.5, 1: 0.5 }, label: '村+狼 tie → 50%' },
      '1,3': { rewardByTeam: { 0: 0.5, 1: 0.5 }, label: '村+狼 tie → 50%' },
      '1,4': { rewardByTeam: { 0: 0.0, 1: 0.5 }, label: '村+狂信 tie → 50% PP' },
      '2,3': { rewardByTeam: { 0: 1.0, 1: 0.0 }, label: '狼 tie → 村勝利確定' },
      '2,4': { rewardByTeam: { 0: 0.5, 1: 0.0 }, label: '狼+狂信 tie' },
      '3,4': { rewardByTeam: { 0: 0.5, 1: 0.0 }, label: '狼+狂信 tie' },
    },
  }
  return {
    name: 'wolfPPIgnoreDesignation',
    description:
      '狼陣営 PP 指定無視. 2 狼 learner + 3 bot (村×2 fixedVote→s2, 狂信 fixedVote→s0). ' +
      '村 2 票は狼 s2 に集中 (designation 遵守)、狂信 1 票は村 s0. 狼は指定遵守=仲間 s2 吊り=陣営敗. ' +
      'defy + coord on s0 で 3 票 (狼2 + 狂信) → 村 s0 単独吊り → PP 成立. penalty -0.2 を飲んで +0.8 each.',
    learningObjective:
      '狼学習: (1) designation penalty -0.2 を飲んでも村 seat に投票、' +
      '(2) 狂信 fixedVote=s0 に合わせて 2 狼も s0 に coordination. ' +
      '理論最大: 両狼 s0 投票 → s0:3 vs s2:2 単独吊り → reward 0.8 each.',
    envConfig,
    analysis: {
      N: 5,
      learningAgentCount: 2,
      botAgentCount: 3,
      majority: 3,
      expectedWinRateOnFullCoordination: 1.0,
    },
    roles: [
      { seat: 0, label: '村1',  kind: 'bot',      team: 'village',  winCondition: '狼全滅',                suggestedVoteTarget: '狼 s2 (designation 遵守)',            knowledge: { 2: ['werewolf', '狼'], 3: ['werewolf', '狼'], 4: ['werewolf', '狂信'] } },
      { seat: 1, label: '村2',  kind: 'bot',      team: 'village',  winCondition: '狼全滅',                suggestedVoteTarget: '狼 s2 (designation 遵守)',            knowledge: { 2: ['werewolf', '狼'], 3: ['werewolf', '狼'], 4: ['werewolf', '狂信'] } },
      { seat: 2, label: '狼1',  kind: 'learning', team: 'werewolf', winCondition: 'PP 成立',              suggestedVoteTarget: '村 s0 (defy + 狂信同調)',            knowledge: { 3: ['werewolf', '狼'], 4: ['werewolf', '狂信'] } },
      { seat: 3, label: '狼2',  kind: 'learning', team: 'werewolf', winCondition: 'PP 成立',              suggestedVoteTarget: '村 s0 (defy + 狂信同調)',            knowledge: { 2: ['werewolf', '狼'], 4: ['werewolf', '狂信'] } },
      { seat: 4, label: '狂信', kind: 'bot',      team: 'werewolf', winCondition: '狼陣営勝利',          suggestedVoteTarget: '村 s0 (固定)',                       knowledge: { 2: ['werewolf', '狼'], 3: ['werewolf', '狼'] } },
    ],
    outcomes: [
      {
        label: '両狼が s0 (defy + 狂信合流)',
        voteTally: 's0: 3 (狼×2 + 狂信), s2: 2 (村×2)',
        result: 's0 単独吊り → PP 成立. 各狼: reward 1.0 - 0.2 penalty = +0.8',
        learnerWinRate: 1.0,
      },
      {
        label: '両狼が指定遵守 (例: 両者 s3 に投票)',
        voteTally: 's0: 1 (狂信), s2: 2 (村), s3: 2 (狼)',
        result: 's2+s3 tie / s0 も含むと "0,2,3" 状況だが tie は "2,3" → team1=0、陣営敗',
        learnerWinRate: 0.0,
      },
      {
        label: '狼 defy 不一致 (狼1→s0, 狼2→s1)',
        voteTally: 's0: 2 (狼1 + 狂信), s1: 1 (狼2), s2: 2 (村)',
        result: 's0 と s2 tie → "0,2" で team1=0.5 - 各狼 -0.2 penalty → +0.3 each',
        learnerWinRate: 0.3,
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
  trio3v2BlockMentored,
  pair2v2SplitMentor,
  trio3v2Mentor,
  pair2designatedSingle,
  trio3designatedRange,
  wolfPPIgnoreDesignation,
}
