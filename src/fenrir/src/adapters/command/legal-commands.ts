/**
 * legalCommands — フェーズ・役職・生死に応じた合法手列挙
 *
 * Phase 1 では骨子として動作するレベル（深い Retar 連動は Phase 3 以降）。
 * - 夜: 役職別に target をフル列挙
 * - 議論: 未 CO なら role_co 候補、CO 済みなら role_result_report 候補、skip 常時可
 * - 指揮: CO 要求 5 種 + 吊り指定（席単位）+ ラン指定（2 席ペア）
 * - CCO: 未 CO 席=cco_full 骨子、CO 済み席=cco_villain_reveal（真 villain のみ）
 */

import type { GameState, PlayerState } from '../../../../lupa/types.ts'
import { alivePlayersExcept, alivePlayers, getSeerResult } from '../../../../lupa/roles.ts'
import type {
  Command, CommandAdapterExt, CoRequestCategory, VillainTrueRole,
} from './command-types.ts'

const CO_REQUEST_CATEGORIES: CoRequestCategory[] = [
  'seer', 'medium', 'bodyguard', 'nekomata', 'nekomata_bodyguard_grelan',
]

export function legalCommands(
  state: GameState<CommandAdapterExt>,
  seat: number,
): Command[] {
  const ext = state.ext
  const player = state.players.find(p => p.seat === seat)
  if (!player || !player.alive) return []

  switch (ext.currentPhase) {
    case 'night':
      return legalNightCommands(state, player)
    case 'discussion':
      return legalDiscussionCommands(state, player)
    case 'commander':
      return seat === ext.commander ? legalCommanderCommands(state) : []
    case 'cco':
      return ext.ccoQueue.includes(seat) ? legalCcoCommands(state, player) : []
    case 'vote':
      return legalVoteCommands(state, player)
  }
}

// ============================================================
// 投票コマンド
// ============================================================

function legalVoteCommands(
  state: GameState<CommandAdapterExt>, player: PlayerState,
): Command[] {
  // voteCandidates が設定されていればそれを使い、なければ生存席全員
  const candidates = state.ext.voteCandidates
    ?? alivePlayers(state).map(p => p.seat)
  const cmds: Command[] = []
  for (const t of candidates) {
    if (t === player.seat) continue  // 自投票不可（lupa 側でも変換されるが合法手から除く）
    cmds.push({ type: 'vote', target: t })
  }
  // フォールバック: 全員が自席だった場合（1席しか生存してない）
  if (cmds.length === 0) {
    for (const t of candidates) cmds.push({ type: 'vote', target: t })
  }
  return cmds
}

// ============================================================
// 夜コマンド
// ============================================================

function legalNightCommands(
  state: GameState<CommandAdapterExt>, player: PlayerState,
): Command[] {
  const cmds: Command[] = [{ type: 'no_action' }]
  const targets = alivePlayersExcept(state, player.seat)

  switch (player.role) {
    case 'seer':
      for (const t of targets) cmds.push({ type: 'divine', target: t.seat })
      break
    case 'bodyguard':
      for (const t of targets) cmds.push({ type: 'guard', target: t.seat })
      break
    case 'werewolf': {
      // 襲撃権限者 = 生存狼のうち最小席番
      const aliveWolves = state.players
        .filter(p => p.alive && p.role === 'werewolf')
        .map(p => p.seat)
        .sort((a, b) => a - b)
      const isLeader = aliveWolves[0] === player.seat
      if (isLeader) {
        const nonWolves = targets.filter(t => t.role !== 'werewolf')
        for (const t of nonWolves) cmds.push({ type: 'attack', target: t.seat })
      }
      break
    }
    default:
      break
  }

  return cmds
}

// ============================================================
// 昼議論コマンド
// ============================================================

function legalDiscussionCommands(
  state: GameState<CommandAdapterExt>, player: PlayerState,
): Command[] {
  const cmds: Command[] = [{ type: 'skip' }]
  const hasClaim = player.claimedRole !== null

  if (!hasClaim) {
    // 初 CO 候補（役職 CO の骨子。results/targets/partner は空またはデフォルトを入れる）
    cmds.push({ type: 'role_co', claim: { type: 'seer_co', results: [] } })
    cmds.push({ type: 'role_co', claim: { type: 'medium_co' } })
    cmds.push({ type: 'role_co', claim: { type: 'bodyguard_co', targets: [] } })
    cmds.push({ type: 'role_co', claim: { type: 'nekomata_co' } })
    // mason_co は partner 必須なので alive プレイヤーで展開
    const others = alivePlayersExcept(state, player.seat)
    for (const o of others) {
      cmds.push({ type: 'role_co', claim: { type: 'mason_co', partner: o.seat } })
    }
    // 真役職 + 履歴あり: 正直 CO バリアント（既知の結果を CO にまとめて添付）
    // 本バリアントを追加することで、初 CO 時にまとめて全日の結果を報告できる。
    if (player.role === 'seer' && player.divineHistory.size > 0) {
      const honestResults = [...player.divineHistory.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, e]) => ({ target: e.target, result: e.result }))
      cmds.push({ type: 'role_co', claim: { type: 'seer_co', results: honestResults } })
    }
    if (player.role === 'medium' && state.executionHistory.size > 0) {
      const honestPast = [...state.executionHistory.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, seat]) => {
          const executed = state.players.find(p => p.seat === seat)
          return executed ? getSeerResult(executed.role) : 'human'
        })
      cmds.push({ type: 'role_co', claim: { type: 'medium_co', pastResults: honestPast } })
    }
  } else {
    // 結果報告（CO 済みなら役職別に列挙）
    switch (player.claimedRole) {
      case 'seer': {
        // 結果報告は死亡席も含む（夜に占って翌朝死亡したケース等を後日報告可能にする）
        const resultTargets = state.players.filter(p => p.seat !== player.seat)
        for (const t of resultTargets) {
          cmds.push({ type: 'role_result_report', claim: { type: 'seer_result', target: t.seat, result: 'human' } })
          cmds.push({ type: 'role_result_report', claim: { type: 'seer_result', target: t.seat, result: 'wolf' } })
        }
        // 予告は未来の夜行動を示すため生存席のみ
        const forecastTargets = alivePlayersExcept(state, player.seat)
        for (const t of forecastTargets) {
          cmds.push({ type: 'role_result_report', claim: { type: 'forecast', target: t.seat } })
        }
        break
      }
      case 'medium':
        cmds.push({ type: 'role_result_report', claim: { type: 'medium_result', result: 'human' } })
        cmds.push({ type: 'role_result_report', claim: { type: 'medium_result', result: 'wolf' } })
        break
      default:
        // bodyguard / mason / nekomata の再報告は Phase 1 では未対応
        break
    }
  }

  return cmds
}

// ============================================================
// 指揮コマンド
// ============================================================

function legalCommanderCommands(state: GameState<CommandAdapterExt>): Command[] {
  // skip は「確信がない時の逃げ道」として常時合法（vote へ直接遷移）
  const cmds: Command[] = [{ type: 'skip' }]
  // request_co は当日すでに要求済みのカテゴリを除外（初日犠牲者等で無限ループを防ぐ）
  const requested = state.ext.requestedCategoriesThisDay
  for (const cat of CO_REQUEST_CATEGORIES) {
    if (requested.has(cat)) continue
    cmds.push({ type: 'request_co', category: cat })
  }
  const alive = alivePlayers(state).map(p => p.seat)

  // 吊り指定（各生存席）
  for (const s of alive) cmds.push({ type: 'designate_execution', target: s })

  // ラン指定（2 席ペアのみ Phase 1）
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      cmds.push({ type: 'designate_runoff', targets: [alive[i], alive[j]] })
    }
  }

  return cmds
}

// ============================================================
// CCO コマンド
// ============================================================

function legalCcoCommands(
  state: GameState<CommandAdapterExt>, player: PlayerState,
): Command[] {
  const cmds: Command[] = [{ type: 'cco_skip' }]
  const hasClaim = player.claimedRole !== null

  if (!hasClaim) {
    // 未 CO 席: cco_full 骨子
    cmds.push({ type: 'cco_full', claim: { type: 'seer_co', results: [] } })
    cmds.push({ type: 'cco_full', claim: { type: 'medium_co' } })
    cmds.push({ type: 'cco_full', claim: { type: 'bodyguard_co', targets: [] } })
    cmds.push({ type: 'cco_full', claim: { type: 'nekomata_co' } })
    // mason_co は partner 席を必要とするため、自席以外の生存席ごとに列挙
    const others = alivePlayersExcept(state, player.seat)
    for (const o of others) {
      cmds.push({ type: 'cco_full', claim: { type: 'mason_co', partner: o.seat } })
    }
  } else {
    // CO 済み席: 人外自白（真 villain のみ）
    if (isVillainRole(player.role)) {
      cmds.push({ type: 'cco_villain_reveal', trueRole: player.role as VillainTrueRole })
    }
  }

  return cmds
}

function isVillainRole(role: string): boolean {
  return role === 'werewolf' || role === 'fanatic' || role === 'werehamster' || role === 'immoralist'
}
