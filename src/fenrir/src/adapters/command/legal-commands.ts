/**
 * legalCommands — フェーズ・役職・生死に応じた合法手列挙
 *
 * Phase 1 では骨子として動作するレベル（深い Retar 連動は Phase 3 以降）。
 * - 夜: 役職別に target をフル列挙
 * - 議論: 未 CO なら role_co 候補、CO 済みなら role_result_report 候補、skip 常時可
 * - 指揮: CO 要求 5 種 + 吊り指定（席単位）+ ラン指定（2 席ペア）
 * - CCO: 未 CO 席=cco_full 骨子、CO 済み席=cco_villain_reveal（真 villain のみ）
 */

import type { EnumSpecies } from '../../../../types/index.ts'
import type { GameState, PlayerState, DayClaim } from '../../../../lupa/types.ts'
import { alivePlayersExcept, alivePlayers, getSeerResult } from '../../../../lupa/roles.ts'
import type {
  Command, CommandAdapterExt, CoRequestCategory, VillainTrueRole,
} from './command-types.ts'

/** 指定ターゲットへの自身の占い履歴から最新結果を取得（未占なら null） */
function latestDivineResult(
  divineHistory: Map<number, { target: number, result: EnumSpecies }>,
  targetSeat: number,
): EnumSpecies | null {
  let latestDay = -1
  let latestResult: EnumSpecies | null = null
  for (const [day, entry] of divineHistory) {
    if (entry.target === targetSeat && day > latestDay) {
      latestDay = day
      latestResult = entry.result
    }
  }
  return latestResult
}

/** 直近の処刑席の真結果（霊能結果として報告されるべき値）。処刑未発生なら null */
function latestMediumResult(state: GameState<CommandAdapterExt>): EnumSpecies | null {
  let latestDay = -1
  let latestSeat: number | null = null
  for (const [day, seat] of state.executionHistory) {
    if (day > latestDay) {
      latestDay = day
      latestSeat = seat
    }
  }
  if (latestSeat === null) return null
  const executed = state.players.find(p => p.seat === latestSeat)
  return executed ? getSeerResult(executed.role) : 'human'
}

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
      // 初日 (day 0) は護衛不可。初日犠牲はランダム固定で護衛は効かない
      if (state.day === 0) break
      for (const t of targets) cmds.push({ type: 'guard', target: t.seat })
      break
    case 'werewolf': {
      // 初日 (day 0) は襲撃なし。初日犠牲 (random) のみ
      if (state.day === 0) break
      // 襲撃権限者 = 生存狼のうち最小席番
      const aliveWolves = state.players
        .filter(p => p.alive && p.role === 'werewolf')
        .map(p => p.seat)
        .sort((a, b) => a - b)
      const isLeader = aliveWolves[0] === player.seat
      if (isLeader) {
        const nonWolves = targets.filter(t => t.role !== 'werewolf')
        for (const actor of aliveWolves) {
          for (const t of nonWolves) cmds.push({ type: 'attack', target: t.seat, actor })
        }
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
  const cmds: Command[] = []
  const hasClaim = player.claimedRole !== null

  if (!hasClaim) {
    // 順序:
    //   1. 自役職に対応する CO（正直バリアント先頭、次に骨子）
    //   2. skip
    //   3. 騙り CO（他役職の CO 候補、UI 末尾へ）
    const matching = roleMatchingCOs(state, player, 'role_co')
    cmds.push(...matching)
    cmds.push({ type: 'skip' })
    cmds.push(...roleMismatchedCOs(state, player, 'role_co'))
  } else {
    cmds.push({ type: 'skip' })
    // 結果報告（CO 済みなら役職別に列挙）
    switch (player.claimedRole) {
      case 'seer': {
        // 結果報告は死亡席も含む（夜に占って翌朝死亡したケース等を後日報告可能にする）
        const resultTargets = state.players.filter(p => p.seat !== player.seat)
        const isTrueSeer = player.role === 'seer'
        for (const t of resultTargets) {
          if (isTrueSeer) {
            // 真 seer: 自分の divineHistory の最新結果のみ合法。未占対象や逆結果は列挙しない
            const latest = latestDivineResult(player.divineHistory, t.seat)
            if (latest !== null) {
              cmds.push({ type: 'role_result_report', claim: { type: 'seer_result', target: t.seat, result: latest } })
            }
          } else {
            // 騙り seer（人外 CO）: 両方の結果を合法手として列挙（嘘可）
            cmds.push({ type: 'role_result_report', claim: { type: 'seer_result', target: t.seat, result: 'human' } })
            cmds.push({ type: 'role_result_report', claim: { type: 'seer_result', target: t.seat, result: 'wolf' } })
          }
        }
        // 予告は未来の夜行動を示すため生存席のみ（騙りは嘘予告可、真役職は戦略自由なので制約なし）
        const forecastTargets = alivePlayersExcept(state, player.seat)
        for (const t of forecastTargets) {
          cmds.push({ type: 'role_result_report', claim: { type: 'forecast', target: t.seat } })
        }
        break
      }
      case 'medium': {
        if (player.role === 'medium') {
          // 真 medium: 直近の処刑席の真役職から一意に決まる結果のみ
          const trueResult = latestMediumResult(state)
          if (trueResult !== null) {
            cmds.push({ type: 'role_result_report', claim: { type: 'medium_result', result: trueResult } })
          }
        } else {
          // 騙り medium（人外 CO）: 両方の結果が合法
          cmds.push({ type: 'role_result_report', claim: { type: 'medium_result', result: 'human' } })
          cmds.push({ type: 'role_result_report', claim: { type: 'medium_result', result: 'wolf' } })
        }
        break
      }
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
  const cmds: Command[] = []
  const hasClaim = player.claimedRole !== null

  if (!hasClaim) {
    // 順序: 自役職の cco_full → cco_skip → 騙り cco_full
    cmds.push(...roleMatchingCOs(state, player, 'cco_full'))
    cmds.push({ type: 'cco_skip' })
    cmds.push(...roleMismatchedCOs(state, player, 'cco_full'))
  } else {
    cmds.push({ type: 'cco_skip' })
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

/**
 * mason_co の partner 候補を並べる。自席以外の全プレイヤー（生存/退場問わず）を返し、
 * 真 mason の場合は真相方席を先頭に置く（UI で正しい選択肢を最上段に表示するため）。
 * それ以外の席は seat 昇順。
 */
function sortMasonPartners(
  state: GameState<CommandAdapterExt>, player: PlayerState,
): PlayerState[] {
  const candidates = state.players.filter(p => p.seat !== player.seat)
  if (player.role !== 'mason') {
    return [...candidates].sort((a, b) => a.seat - b.seat)
  }
  const truePartner = candidates.find(p => p.role === 'mason')
  const others = candidates
    .filter(p => p.seat !== truePartner?.seat)
    .sort((a, b) => a.seat - b.seat)
  return truePartner ? [truePartner, ...others] : others
}

/** CO 系コマンドの外枠: discussion なら role_co、CCO なら cco_full */
type CoOuterType = 'role_co' | 'cco_full'

function makeCoCmd(
  outer: CoOuterType, claim: DayClaim,
): Command {
  if (outer === 'role_co') {
    return { type: 'role_co', claim }
  }
  return { type: 'cco_full', claim }
}

/**
 * 自役職に一致する CO 候補を優先度順で返す。
 * 正直バリアント（履歴ありなら）→ 骨子（空 results / targets）→ mason なら真相方を頭にした partner 全列挙。
 * villager/werewolf/fanatic/werehamster/immoralist は真の CO 先無しなので空配列。
 */
function roleMatchingCOs(
  state: GameState<CommandAdapterExt>, player: PlayerState, outer: CoOuterType,
): Command[] {
  switch (player.role) {
    case 'seer': {
      const list: Command[] = []
      if (player.divineHistory.size > 0) {
        const honestResults = [...player.divineHistory.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, e]) => ({ target: e.target, result: e.result }))
        list.push(makeCoCmd(outer, { type: 'seer_co', results: honestResults }))
      }
      list.push(makeCoCmd(outer, { type: 'seer_co', results: [] }))
      return list
    }
    case 'medium': {
      const list: Command[] = []
      if (state.executionHistory.size > 0) {
        const honestPast = [...state.executionHistory.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, seat]) => {
            const executed = state.players.find(p => p.seat === seat)
            return executed ? getSeerResult(executed.role) : 'human'
          })
        list.push(makeCoCmd(outer, { type: 'medium_co', pastResults: honestPast }))
      }
      list.push(makeCoCmd(outer, { type: 'medium_co' }))
      return list
    }
    case 'bodyguard':
      return [makeCoCmd(outer, { type: 'bodyguard_co', targets: [] })]
    case 'nekomata':
      return [makeCoCmd(outer, { type: 'nekomata_co' })]
    case 'mason': {
      // 真 mason は真相方とだけ matching に入れる（他席の partner 指定は騙り扱いで bluff へ）
      const truePartner = state.players.find(p =>
        p.role === 'mason' && p.seat !== player.seat,
      )
      if (truePartner) {
        return [makeCoCmd(outer, { type: 'mason_co', partner: truePartner.seat })]
      }
      // 想定外（相方が見つからない）: 何も返さない
      return []
    }
    default:
      return []
  }
}

/**
 * 自役職以外の CO 候補（騙り用）を UI 末尾に並べるためにまとめる。
 * 自役職に一致するものは除外。mason_co は真 mason でない限り全 partner を列挙。
 */
function roleMismatchedCOs(
  state: GameState<CommandAdapterExt>, player: PlayerState, outer: CoOuterType,
): Command[] {
  const list: Command[] = []
  if (player.role !== 'seer') {
    list.push(makeCoCmd(outer, { type: 'seer_co', results: [] }))
  }
  if (player.role !== 'medium') {
    list.push(makeCoCmd(outer, { type: 'medium_co' }))
  }
  if (player.role !== 'bodyguard') {
    list.push(makeCoCmd(outer, { type: 'bodyguard_co', targets: [] }))
  }
  if (player.role !== 'nekomata') {
    list.push(makeCoCmd(outer, { type: 'nekomata_co' }))
  }
  // mason_co は「自役職以外」なら全 partner 候補、「mason」なら真相方以外を騙り扱いに
  if (player.role !== 'mason') {
    for (const o of sortMasonPartners(state, player)) {
      list.push(makeCoCmd(outer, { type: 'mason_co', partner: o.seat }))
    }
  } else {
    const truePartnerSeat = state.players.find(p =>
      p.role === 'mason' && p.seat !== player.seat,
    )?.seat
    for (const o of sortMasonPartners(state, player)) {
      if (o.seat === truePartnerSeat) continue
      list.push(makeCoCmd(outer, { type: 'mason_co', partner: o.seat }))
    }
  }
  return list
}
