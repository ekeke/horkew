import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig } from '../types.ts'
import type { GameConfig, GameHandlers, PhaseContext } from '../handlers.ts'
import type { GameState } from '../types.ts'
import type { DecisionContext } from '../strategy.ts'
import { runGame } from '../engine.ts'
import { strategyAdapter } from '../adapters/strategy-adapter.ts'
import { RandomStrategy } from '../random-strategy.ts'
import { scenarios, findScenario } from '../scenarios.ts'
import { HumanCliStrategy } from './human-strategy.ts'
import { roleName, roleColor, displayNewEvents } from './display.ts'

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
} as const

function usage(): void {
  console.log(`
${C.bold}Horkew Interactive Werewolf CLI${C.reset}

Usage:
  node --experimental-strip-types src/lupa/interactive/cli.ts [options]

Options:
  --scenario <name>     シナリオ名 (例: 14d-neko, standard-10p)
  --roles <spec>        配役指定 (例: werewolf:2,villager:5,seer:1)
  --my-role <role>      希望役職 (例: seer, werewolf)
  --seed <n>            乱数シード
  --no-retar            Retar推論を無効化
  --list-scenarios      シナリオ一覧を表示

Scenarios:`)
  for (const s of scenarios) {
    const roleStr = Object.entries(s.roles).map(([r, n]) => `${r}:${n}`).join(', ')
    console.log(`  ${C.bold}${s.name}${C.reset} — ${roleStr}`)
  }
}

function parseRoles(spec: string): Map<SystemRole, number> {
  const roles = new Map<SystemRole, number>()
  for (const part of spec.split(',')) {
    const [role, countStr] = part.trim().split(':')
    const count = parseInt(countStr, 10)
    if (!role || isNaN(count)) {
      console.error(`Invalid role spec: ${part}`)
      process.exit(1)
    }
    roles.set(role.trim() as SystemRole, count)
  }
  return roles
}

function buildHumanCtx(pctx: PhaseContext, seat: number): DecisionContext {
  const state = pctx.state as GameState
  const player = state.players.find(p => p.seat === seat)!
  return {
    mySeat: player.seat,
    myRole: player.role,
    myPlayer: player,
    day: pctx.day,
    phase: state.phase,
    alivePlayers: pctx.alivePlayers,
    publicEvents: [...pctx.events],
    signals: [],
    commander: state.commander,
    proposals: [],
    rng: { next: () => Math.random(), nextInt: (n: number) => Math.floor(Math.random() * n), shuffle: <T>(a: T[]) => a } as any,
    gameState: state,
    lastExecutedSeat: null,
    retarPossibilities: null,
    maxSurvivingNV: null,
    globalRetarPossibilities: null,
    wolfTeammates: null,
    knownWolves: null,
    knownHamster: null,
    masonPartner: null,
    revoteRound: null,
    revoteCandidates: null,
    executionPlans: [],
    tsumiTarget: null,
    rules: pctx.rules,
  }
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    usage()
    process.exit(0)
  }
  if (args.includes('--list-scenarios')) {
    usage()
    process.exit(0)
  }

  let roles: Map<SystemRole, number> | undefined
  let myRole: SystemRole | undefined
  let seed: number | undefined
  let enableRetar = true
  let scenarioName: string | undefined
  let hasFirstGhost = false
  let revoteConfig: LupaConfig['revoteConfig']

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--scenario':
        scenarioName = args[++i]
        break
      case '--roles':
        roles = parseRoles(args[++i])
        break
      case '--my-role':
        myRole = args[++i] as SystemRole
        break
      case '--seed':
        seed = parseInt(args[++i], 10)
        break
      case '--no-retar':
        enableRetar = false
        break
    }
  }

  if (scenarioName) {
    const scenario = findScenario(scenarioName)
    if (!scenario) {
      console.error(`Unknown scenario: ${scenarioName}`)
      usage()
      process.exit(1)
    }
    roles = new Map(Object.entries(scenario.roles) as Array<[SystemRole, number]>)
    hasFirstGhost = scenario.hasFirstGhost ?? false
    revoteConfig = scenario.revoteConfig
  }

  if (!roles) {
    // デフォルト: 14d-neko
    const defaultScenario = findScenario('14d-neko')!
    roles = new Map(Object.entries(defaultScenario.roles) as Array<[SystemRole, number]>)
    hasFirstGhost = defaultScenario.hasFirstGhost ?? false
    revoteConfig = defaultScenario.revoteConfig
    scenarioName = '14d-neko'
  }

  const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

  console.log(`\n${C.bold}${'═'.repeat(50)}${C.reset}`)
  console.log(`${C.bold}  Horkew Interactive Werewolf${C.reset}`)
  console.log(`${C.bold}${'═'.repeat(50)}${C.reset}`)
  if (scenarioName) console.log(`  シナリオ: ${C.cyan}${scenarioName}${C.reset}`)
  console.log(`  プレイヤー数: ${totalPlayers}`)
  const roleStr = Array.from(roles.entries()).map(([r, n]) => `${roleName(r)}×${n}`).join(', ')
  console.log(`  配役: ${roleStr}`)
  if (myRole) console.log(`  希望役職: ${roleColor(myRole)}${roleName(myRole)}${C.reset}`)
  if (seed !== undefined) console.log(`  シード: ${seed}`)
  console.log()

  const humanStrategy = new HumanCliStrategy()
  let humanSeat: number | undefined

  const gameConfig: GameConfig = {
    roles,
    seed,
    hasFirstGhost,
    revoteConfig,
  }

  const baseHandlers = strategyAdapter({
    defaultStrategy: new RandomStrategy(),
    enableRetar,
    seed,
    roles,
    onRolesAssigned: (seatRoles) => {
      if (myRole) {
        // 希望役職のseatを探す
        for (const [seat, role] of seatRoles) {
          if (role === myRole) {
            humanSeat = seat
            break
          }
        }
        if (humanSeat === undefined) {
          console.error(`希望役職 ${myRole} が割り当てに存在しません`)
          process.exit(1)
        }
      } else {
        // ランダムにseatを割り当て
        const seats = Array.from(seatRoles.keys())
        humanSeat = seats[Math.floor(Math.random() * seats.length)]
      }

      humanStrategy.setSeat(humanSeat!)

      const assignedRole = seatRoles.get(humanSeat!)!
      console.log(`${C.bold}あなたの席: ${humanSeat}${C.reset}`)
      console.log(`${C.bold}あなたの役職: ${roleColor(assignedRole)}${roleName(assignedRole)}${C.reset}`)
      console.log()
    },
  })

  // Wrap base handlers to intercept human player's async decisions
  const handlers: GameHandlers = {
    onSetup: baseHandlers.onSetup,

    async onNight(ctx) {
      const actions = await baseHandlers.onNight(ctx)
      if (humanSeat !== undefined && ctx.alivePlayers.includes(humanSeat)) {
        const decisionCtx = buildHumanCtx(ctx, humanSeat)
        actions.set(humanSeat, await humanStrategy.decideNightAction(decisionCtx))
      }
      return actions
    },

    async onDayClaims(ctx) {
      const claims = await baseHandlers.onDayClaims(ctx)
      if (humanSeat !== undefined && ctx.alivePlayers.includes(humanSeat)) {
        const decisionCtx = buildHumanCtx(ctx, humanSeat)
        claims.set(humanSeat, await humanStrategy.decideDayClaim(decisionCtx))
      }
      return claims
    },

    onPreVote: baseHandlers.onPreVote,

    async onVote(vctx) {
      const votes = await baseHandlers.onVote(vctx)
      if (humanSeat !== undefined && vctx.alivePlayers.includes(humanSeat)) {
        const decisionCtx = buildHumanCtx(vctx, humanSeat)
        votes.set(humanSeat, await humanStrategy.decideVote(decisionCtx))
      }
      return votes
    },
  }

  try {
    const result = await runGame(gameConfig, handlers)

    // 人間が死んだ後のイベントも含め、未表示のイベントを全て表示
    const lastCursor = humanStrategy.getEventCursor()
    if (lastCursor < result.events.length) {
      displayNewEvents(result.events, lastCursor, result.state)
    }

    // 最終結果
    console.log(`\n${C.bold}${'═'.repeat(50)}${C.reset}`)
    console.log(`${C.bold}  ゲーム終了${C.reset}`)
    console.log(`${C.bold}${'═'.repeat(50)}${C.reset}`)

    const gameOver = result.events.find(e => e.type === 'game_over')
    if (gameOver && gameOver.type === 'game_over') {
      const resultMap: Record<string, string> = {
        villager_won: `${C.green}${C.bold}村人陣営の勝利!${C.reset}`,
        werewolf_won: `${C.red}${C.bold}人狼陣営の勝利!${C.reset}`,
        werehamster_won: `\x1b[35m${C.bold}妖狐の勝利!${C.reset}`,
        draw: `${C.yellow}${C.bold}引き分け${C.reset}`,
      }
      console.log(`\n  結果: ${resultMap[gameOver.result]}`)
    }

    console.log(`\n  ${C.bold}--- 配役公開 ---${C.reset}`)
    for (const player of result.state.players) {
      const alive = player.alive ? `${C.green}生存${C.reset}` : `${C.red}死亡${C.reset}`
      console.log(`  ${player.seat}: ${player.name} — ${roleColor(player.role)}${roleName(player.role)}${C.reset} (${alive})`)
    }
  } finally {
    humanStrategy.close()
  }
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err)
  process.exit(1)
})

main().catch(err => {
  console.error(err)
  process.exit(1)
})
