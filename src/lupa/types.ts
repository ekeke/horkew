import type { SystemRole, EnumSpecies, Regulation } from '../types/index.ts'

export type LupaConfig = {
  roles: Map<SystemRole, number>
  seed?: number
  verify?: boolean
  useRandomNames?: boolean
  hasFirstGhost?: boolean
  /** 再投票設定 (未指定時はデフォルト: 候補者限定ランダム、3回、最小seat処刑) */
  revoteConfig?: RevoteConfig
  /** 投票確定後のCO許可 = 遺言 (デフォルト: false) */
  allowPostVoteCO?: boolean
  /** オプションルール（未指定分はるる鯛14D猫デフォルト） */
  rules?: Partial<Regulation>
}

export type RevoteConfig = {
  /** 最大再投票回数 (デフォルト: 3) */
  maxRevotes: number
  /** 再投票方式: 'random_tied' = 候補者限定ランダム(現行), 'full_revote' = 全員で完全やり直し */
  style: 'random_tied' | 'full_revote'
  /**
   * 決着つかない場合の最終決定方式:
   * - 'lowest_seat' = 最小 seat 処刑 (engine 内部 default)
   * - 'draw' = 引き分け終局
   * - 'random' = tied 候補から rng で 1 人 pick (vote.tiebreaker=random)
   * - 'no-lynch' = 誰も処刑せず次の Night へ進む (vote.tiebreaker=no-lynch)
   */
  tiebreaker: 'lowest_seat' | 'draw' | 'random' | 'no-lynch'
}

export type PlayerState = {
  seat: number
  name: string
  role: SystemRole
  alive: boolean
  claimedRole: SystemRole | null
  claimedDay: number | null
  // 占い師: 実際の占い結果
  divineHistory: Map<number, { target: number, result: EnumSpecies }>
  // 狩人: 護衛先
  guardHistory: Map<number, number>
  // 人狼: その夜にチームが集約決定した襲撃 target (= 全 attack 提案者が共有)
  attackHistory: Map<number, number>
  // 霊能者: 処刑された人物の種別 (auto-info:execution-species trait を持つ役職のみ engine が push)
  // day → { target: 処刑された seat, result: 霊能結果の種別 }
  mediumHistory: Map<number, { target: number, result: EnumSpecies }>
  // 狂人: 偽占い結果
  fakeDivineHistory: Map<number, { target: number, result: EnumSpecies }>
  // 予告先（次の夜に占う対象）
  forecastTarget: number | null
}

export type GameState<Ext = unknown> = {
  players: PlayerState[]
  day: number
  phase: 'night' | 'day'
  finished: boolean
  result: 'villager_won' | 'werewolf_won' | 'werehamster_won' | 'draw' | null
  /** 処刑履歴: day → seat */
  executionHistory: Map<number, number>
  /** 現在の指揮者 (seat) */
  commander: number | null
  /** 共有CO時のpartner記録: seat → partnerSeat */
  masonPartners?: Map<number, number>
  /**
   * 翌朝発動の遅延死亡 (= night_kill 扱い) を予約する seat 配列。
   * role.nekomata.curse-immediately=false や role.immoralist.follow-immediately=false
   * のような「次の朝に効果」 ルールで利用。 次の day iteration の夜フェーズ後に処理されて空に戻る。
   * 外部から手動で state を構築するテスト互換のため optional。 engine は遅延初期化する。
   */
  pendingNightKills?: number[]
  /** Consumer定義の拡張データ。Lupaは中身に触らない。structuredCloneで自動複製される。 */
  ext: Ext
}

export type NightAction =
  | { type: 'divine', target: number }
  | { type: 'guard', target: number }
  | { type: 'attack', target: number }
  | { type: 'none' }

export type DayClaim =
  | { type: 'seer_co', results: Array<{ day: number, target: number, result: EnumSpecies }> }
  | { type: 'seer_result', target: number, result: EnumSpecies }
  | { type: 'medium_co', pastResults?: EnumSpecies[] }
  | { type: 'medium_result', result: EnumSpecies }
  | { type: 'bodyguard_co', targets: number[] }
  | { type: 'mason_co', partner: number }
  | { type: 'nekomata_co' }
  | { type: 'forecast', target: number }
  | { type: 'none' }

export type GameEvent =
  | { type: 'night_kill', target: number }
  | { type: 'fox_kill', target: number }
  | { type: 'peace' }
  | { type: 'seer_claim', actor: number, results: Array<{ day: number, target: number, result: EnumSpecies }> }
  | { type: 'seer_result', actor: number, target: number, result: EnumSpecies }
  | { type: 'medium_claim', actor: number, pastResults?: EnumSpecies[] }
  | { type: 'medium_result', actor: number, result: EnumSpecies }
  | { type: 'bodyguard_claim', actor: number, targets: number[] }
  | { type: 'mason_claim', actor: number, partner: number }
  | { type: 'nekomata_claim', actor: number }
  | { type: 'forecast', actor: number, target: number }
  | { type: 'curse_kill', target: number }
  | { type: 'follow_kill', target: number }
  | { type: 'vote', voter: number, target: number }
  | { type: 'revote', targets: number[] }
  | { type: 'no_lynch', tied: number[] }
  | { type: 'grelan' }
  | { type: 'execution', target: number }
  | { type: 'comment', text: string }
  | { type: 'game_over', result: 'villager_won' | 'werewolf_won' | 'werehamster_won' | 'draw' }
  | { type: 'reveal', seat: number, role: SystemRole }

/** 中盤スナップショット（Seed Bank 用） */
export type GameSnapshot<E = never, Ext = unknown> = {
  state: GameState<Ext>
  events: (GameEvent | E)[]
  rngState: number
  config: import('./handlers.ts').GameConfig
  seatRoles: Map<number, SystemRole>
}
