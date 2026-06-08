import { systemRoles } from '../types/index.ts'
import type { SystemRole, EnumSpecies } from '../types/index.ts'
import type { GameState, PlayerState } from './types.ts'
import { hasTrait, isFoxWinCounter } from './role-traits.ts'

export function assignRoles(
  roleConfig: Map<SystemRole, number>,
  names: string[],
  shuffledIndices: number[],
): PlayerState[] {
  const roles: SystemRole[] = []
  for (const [role, count] of roleConfig) {
    if (count > 0 && systemRoles.get(role)?.lupaSupported === false) {
      throw new Error(`役職 "${role}" は lupa engine 非対応です`)
    }
    for (let i = 0; i < count; i++) roles.push(role)
  }

  if (roles.length !== names.length) {
    throw new Error(`役職数 (${roles.length}) とプレイヤー数 (${names.length}) が一致しません`)
  }

  const shuffledRoles = shuffledIndices.map(i => roles[i])

  return names.map((name, i) => ({
    seat: i + 1,
    name,
    role: shuffledRoles[i],
    alive: true,
    claimedRole: null,
    claimedDay: null,
    divineHistory: new Map(),
    guardHistory: new Map(),
    attackHistory: new Map(),
    mediumHistory: new Map(),
    fakeDivineHistory: new Map(),
    forecastTarget: null,
  }))
}

export function getSeerResult(targetRole: SystemRole): EnumSpecies {
  const role = systemRoles.get(targetRole)
  return role?.seerResult ?? 'human'
}

export function getMediumResult(targetRole: SystemRole): EnumSpecies {
  const role = systemRoles.get(targetRole)
  return role?.mediumResult ?? 'human'
}

export function isWerewolfAligned(role: SystemRole): boolean {
  const r = systemRoles.get(role)
  return r?.alignment === 'werewolf'
}

export function isVillagerAligned(role: SystemRole): boolean {
  const r = systemRoles.get(role)
  return r?.alignment === 'villager'
}

export function alivePlayers(state: GameState): PlayerState[] {
  return state.players.filter(p => p.alive)
}

export function alivePlayersExcept(state: GameState, ...exclude: number[]): PlayerState[] {
  const s = new Set(exclude)
  return state.players.filter(p => p.alive && !s.has(p.seat))
}

export function killPlayer(state: GameState, seat: number): void {
  const player = state.players.find(p => p.seat === seat)
  if (player) player.alive = false
}

/** 勝利判定。勝利条件を満たした場合resultをセット */
export function checkWinCondition(state: GameState): void {
  const alive = alivePlayers(state)
  // 襲撃可能個体 (= 人狼) のみで勝利判定。パパラッチ等の狼陣営非襲撃役は wolves には含まれない
  const wolves = alive.filter(p => hasTrait(p.role, 'action', 'attack'))
  // 狐陣営勝利カウント担当 (妖狐 + 子狐) のうち 1 人でも生存していれば狐勝ち
  const hamsters = alive.filter(p => isFoxWinCounter(p.role))
  // 勝利判定では狐陣営勝利カウント担当は人数にカウントしない
  const nonHamsterAlive = alive.filter(p => !isFoxWinCounter(p.role))
  const nonWolfCount = nonHamsterAlive.filter(p => !hasTrait(p.role, 'action', 'attack')).length

  if (wolves.length === 0) {
    // 人狼全滅
    if (hamsters.length > 0) {
      state.finished = true
      state.result = 'werehamster_won'
    } else {
      state.finished = true
      state.result = 'villager_won'
    }
  } else if (wolves.length >= nonWolfCount) {
    // 人狼が過半数
    if (hamsters.length > 0) {
      state.finished = true
      state.result = 'werehamster_won'
    } else {
      state.finished = true
      state.result = 'werewolf_won'
    }
  }
}
