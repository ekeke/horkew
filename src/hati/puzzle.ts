/**
 * 詰め人狼 puzzle generator.
 *
 * ランダムな村構成・ランダムな進行の中から、Hati が「村必勝」と判定する
 * 局面（昼の投票直前）を puzzle として抽出する。
 */

import type { SystemRole } from '../types/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import type { GameConfig, GameHandlers } from '../lupa/handlers.ts'
import { runGame } from '../lupa/engine.ts'
import { makeRandomHandlers } from '../lupa/test-helpers.ts'
import { Rng } from '../lupa/random.ts'
import { gameToHowl } from '../lupa/to-howl.ts'
import { findScenario, scenarioToRoles, type Scenario } from '../lupa/scenarios.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { searchTsumi } from './index.ts'

const ALL_ROLES: SystemRole[] = [
  'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
  'possessed', 'fanatic', 'immoralist', 'werehamster', 'werewolf',
]

const VILLAGE_ROLES: SystemRole[] = [
  'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
]

const OUTSIDER_ROLES: SystemRole[] = [
  'possessed', 'fanatic', 'immoralist', 'werehamster', 'werewolf',
]

const MIN_PLAYERS = 9
const MAX_PLAYERS = 14
const MAX_NEKOMATA = 1
const SETUP_GENERATION_ATTEMPTS = 1000

const DEFAULT_ANALYZE_OPTIONS: AnalyzeOptions = {
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

/**
 * ランダムな村構成を生成する。
 *
 * - 人数: MIN_PLAYERS〜MAX_PLAYERS から一様乱択
 * - 各席に ALL_ROLES から一様ランダムに役職を割り当て
 * - 制約を満たさなければ reject sampling
 */
export function generateRandomSetup(rng: Rng): Map<SystemRole, number> {
  for (let attempt = 0; attempt < SETUP_GENERATION_ATTEMPTS; attempt++) {
    const n = MIN_PLAYERS + rng.nextInt(MAX_PLAYERS - MIN_PLAYERS + 1)
    const counts = new Map<SystemRole, number>()
    for (const role of ALL_ROLES) counts.set(role, 0)

    for (let i = 0; i < n; i++) {
      const role = ALL_ROLES[rng.nextInt(ALL_ROLES.length)]
      counts.set(role, counts.get(role)! + 1)
    }

    const wolves = counts.get('werewolf')!
    let village = 0
    for (const r of VILLAGE_ROLES) village += counts.get(r)!
    let outsiders = 0
    for (const r of OUTSIDER_ROLES) outsiders += counts.get(r)!

    if (wolves < 1) continue
    if (village < 1) continue
    if ((wolves + 1) * 2 >= n) continue
    if (outsiders * 2 >= n) continue
    if (counts.get('nekomata')! > MAX_NEKOMATA) continue

    const setup = new Map<SystemRole, number>()
    for (const [role, count] of counts) {
      if (count > 0) setup.set(role, count)
    }
    return setup
  }
  throw new Error('generateRandomSetup: failed to satisfy constraints within attempt budget')
}

export type FindTsumiPuzzleOptions = {
  /** 詰みが見つからなかった場合に試行するゲームの上限本数 (default 1) */
  maxGames?: number
  /** 指定すると村構成をランダム生成せず scenarios.ts の該当プリセットに固定する */
  scenario?: string
  /** 投票直前時点での最低生存者数 (これ未満の puzzle は不採用) */
  minAlive?: number
  /** 投票直前時点で指定役職すべてが 1 人以上生存している必要がある (AND 条件) */
  aliveRoles?: SystemRole[]
}

class TsumiFoundError extends Error {
  readonly howl: string
  constructor(howl: string) {
    super('tsumi found')
    this.howl = howl
  }
}

/**
 * seed から詰み盤面を探索する。
 *
 * - seed で PRNG を初期化し setup・進行のすべての乱数を駆動する
 * - 1 ゲーム = setup 生成 → ランダム進行 → 各昼の投票直前で searchTsumi
 *   詰み (`isTsumi=true`) が見つかった瞬間に、そこまでの公開ログを .howl 文字列で返す
 * - 詰みが見つからずゲームが終了したら次の試行へ。`maxGames` まで反復
 * - 最後まで詰みが出なければ null
 */
export async function findTsumiPuzzle(
  seed: number,
  opts: FindTsumiPuzzleOptions = {},
): Promise<string | null> {
  const masterRng = new Rng(seed)
  const maxGames = opts.maxGames ?? 1
  let fixedScenario: Scenario | undefined
  if (opts.scenario !== undefined) {
    fixedScenario = findScenario(opts.scenario)
    if (fixedScenario === undefined) {
      throw new Error(`findTsumiPuzzle: unknown scenario "${opts.scenario}"`)
    }
  }

  for (let g = 0; g < maxGames; g++) {
    const setup = fixedScenario ? scenarioToRoles(fixedScenario) : generateRandomSetup(masterRng)
    const gameSeed = (masterRng.next() * 0x7FFFFFFF) | 0
    const found = await tryFindInOneGame(setup, gameSeed, fixedScenario, opts.minAlive ?? 0, opts.aliveRoles ?? [])
    if (found !== null) return injectSeedComment(found, seed)
  }
  return null
}

function injectSeedComment(howl: string, seed: number): string {
  const match = howl.match(/^(---\n[\s\S]*?---\n)/)
  const comment = `# seed: ${seed}\n`
  if (match) return match[1] + comment + howl.slice(match[1].length)
  return comment + howl
}

async function tryFindInOneGame(
  setup: Map<SystemRole, number>,
  gameSeed: number,
  scenario: Scenario | undefined,
  minAlive: number,
  requiredAliveRoles: SystemRole[],
): Promise<string | null> {
  const config: GameConfig = {
    roles: setup,
    seed: gameSeed,
    ...(scenario?.hasFirstGhost !== undefined ? { hasFirstGhost: scenario.hasFirstGhost } : {}),
    ...(scenario?.revoteConfig !== undefined ? { revoteConfig: scenario.revoteConfig } : {}),
  }

  const base = makeRandomHandlers(gameSeed)

  const handlers: GameHandlers = {
    onSetup: base.onSetup,
    onNight: base.onNight,
    onDayClaims: base.onDayClaims,
    onVote: base.onVote,
    onPreVote: (ctx) => {
      if (ctx.alivePlayers.length < minAlive) return {}
      if (requiredAliveRoles.length > 0) {
        const aliveRoleSet = new Set<SystemRole>()
        for (const p of ctx.state.players) {
          if (p.alive) aliveRoleSet.add(p.role)
        }
        for (const r of requiredAliveRoles) {
          if (!aliveRoleSet.has(r)) return {}
        }
      }
      const partial = { events: ctx.events as any, state: ctx.state as any, config }
      const howl = gameToHowl(partial, { includeExpect: false, includeRoles: false })
      const parsed = parse(howl)
      const { vs, setup: parsedSetup } = buildVillageStatus(parsed.statements, parsed.meta)
      const result = searchTsumi(vs, parsedSetup, DEFAULT_ANALYZE_OPTIONS)
      if (result.isTsumi) {
        throw new TsumiFoundError(howl)
      }
      return {}
    },
  }

  try {
    await runGame(config, handlers)
  } catch (e) {
    if (e instanceof TsumiFoundError) return e.howl
    throw e
  }
  return null
}
