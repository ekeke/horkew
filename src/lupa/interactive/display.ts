import type { SystemRole } from '../../types/index.ts'
import type { GameState, GameEvent, PlayerState } from '../types.ts'
import type { DecisionContext } from '../strategy.ts'
import type { Signal } from '../communication.ts'

// ANSI color codes
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgBlue: '\x1b[44m',
} as const

const ROLE_NAMES: Record<SystemRole, string> = {
  villager: '村人',
  seer: '占い師',
  medium: '霊能者',
  bodyguard: '狩人',
  mason: '共有者',
  nekomata: '猫又',
  werewolf: '人狼',
  possessed: '狂人',
  fanatic: '狂信者',
  werehamster: '妖狐',
  immoralist: '背徳者',
}

const ALIGNMENT_COLOR: Record<string, string> = {
  villager: C.green,
  werewolf: C.red,
  possessed: C.red,
  fanatic: C.red,
  werehamster: C.magenta,
  immoralist: C.magenta,
}

export function roleColor(role: SystemRole): string {
  return ALIGNMENT_COLOR[role] ?? C.green
}

export function roleName(role: SystemRole): string {
  return ROLE_NAMES[role]
}

export function playerLabel(player: PlayerState, showRole?: boolean): string {
  const alive = player.alive ? C.green + '生' : C.red + '死'
  const roleStr = showRole ? ` ${roleColor(player.role)}${roleName(player.role)}${C.reset}` : ''
  const claimed = player.claimedRole ? ` [CO:${roleName(player.claimedRole)}]` : ''
  return `${C.bold}${player.seat}${C.reset}:${player.name} ${alive}${C.reset}${roleStr}${claimed}`
}

export function displayPhaseHeader(day: number, phase: 'night' | 'day'): void {
  const icon = phase === 'night' ? '🌙' : '☀️'
  const color = phase === 'night' ? C.blue : C.yellow
  console.log(`\n${color}${C.bold}${'═'.repeat(50)}${C.reset}`)
  console.log(`${color}${C.bold}  ${icon} ${phase === 'night' ? '夜' : '昼'} ${day}日目${C.reset}`)
  console.log(`${color}${C.bold}${'═'.repeat(50)}${C.reset}`)
}

export function displayPlayerList(state: GameState, humanSeat: number): void {
  console.log(`\n${C.bold}--- プレイヤー一覧 ---${C.reset}`)
  for (const player of state.players) {
    const me = player.seat === humanSeat ? ` ${C.cyan}<<< あなた${C.reset}` : ''
    console.log(`  ${playerLabel(player)}${me}`)
  }
}

export function displayPrivateKnowledge(ctx: DecisionContext, state: GameState): void {
  const pName = (seat: number) => state.players.find(p => p.seat === seat)?.name ?? `???`

  console.log(`\n${C.bold}--- あなたの情報 ---${C.reset}`)
  console.log(`  役職: ${roleColor(ctx.myRole)}${C.bold}${roleName(ctx.myRole)}${C.reset}`)

  if (ctx.wolfTeammates && ctx.wolfTeammates.length > 0) {
    const names = ctx.wolfTeammates.map(s => `${pName(s)}(${s})`).join(', ')
    console.log(`  ${C.red}仲間の人狼: ${names}${C.reset}`)
  }
  if (ctx.knownWolves && ctx.knownWolves.length > 0) {
    const names = ctx.knownWolves.map(s => `${pName(s)}(${s})`).join(', ')
    console.log(`  ${C.red}人狼: ${names}${C.reset}`)
  }
  if (ctx.knownHamster !== null) {
    console.log(`  ${C.magenta}妖狐: ${pName(ctx.knownHamster)}(${ctx.knownHamster})${C.reset}`)
  }
  if (ctx.masonPartner !== null) {
    console.log(`  ${C.green}共有者の相方: ${pName(ctx.masonPartner)}(${ctx.masonPartner})${C.reset}`)
  }

  // 占い結果
  if (ctx.myPlayer.divineHistory.size > 0) {
    console.log(`  ${C.cyan}占い結果:${C.reset}`)
    for (const [night, result] of ctx.myPlayer.divineHistory) {
      const species = result.result === 'human' ? `${C.green}○人間${C.reset}` : `${C.red}●人狼${C.reset}`
      console.log(`    ${night}夜: ${pName(result.target)}(${result.target}) → ${species}`)
    }
  }

  // 護衛履歴
  if (ctx.myPlayer.guardHistory.size > 0) {
    console.log(`  ${C.cyan}護衛履歴:${C.reset}`)
    for (const [night, target] of ctx.myPlayer.guardHistory) {
      console.log(`    ${night}夜: ${pName(target)}(${target})`)
    }
  }

  // 偽占い結果
  if (ctx.myPlayer.fakeDivineHistory.size > 0) {
    console.log(`  ${C.yellow}偽占い結果:${C.reset}`)
    for (const [night, result] of ctx.myPlayer.fakeDivineHistory) {
      const species = result.result === 'human' ? '○人間' : '●人狼'
      console.log(`    ${night}夜: ${pName(result.target)}(${result.target}) → ${species}`)
    }
  }
}

export function displayRetarSummary(ctx: DecisionContext, state: GameState): void {
  if (!ctx.retarPossibilities || ctx.retarPossibilities.size === 0) return
  const pName = (seat: number) => state.players.find(p => p.seat === seat)?.name ?? `???`

  console.log(`\n${C.bold}--- Retar推理 ---${C.reset}`)
  for (const player of state.players) {
    if (!player.alive) continue
    const roles = ctx.retarPossibilities.get(player.seat)
    if (!roles) continue
    const roleStrs = [...roles].map(r => `${roleColor(r)}${roleName(r)}${C.reset}`)
    const confirmed = roles.size === 1 ? ' ★' : ''
    console.log(`  ${player.seat}:${pName(player.seat)} → ${roleStrs.join(', ')}${confirmed}`)
  }
}

function formatSignal(signal: Signal, state: GameState): string {
  const pName = (seat: number) => state.players.find(p => p.seat === seat)?.name ?? `???`
  switch (signal.type) {
    case 'suspicion': return `疑い→${pName(signal.target)}`
    case 'trust': return `信頼→${pName(signal.target)}`
    case 'vote_intent': return `投票意思→${pName(signal.target)}`
    case 'accuse_wolf': return `人狼告発→${pName(signal.target)}`
    case 'accuse_fox': return `妖狐告発→${pName(signal.target)}`
    case 'agree': return `同意→${pName(signal.target)}`
    case 'disagree': return `反対→${pName(signal.target)}`
    case 'nominate_commander': return `指揮者推薦→${pName(signal.target)}`
    case 'demand_wolf_co': return '人狼CO要求'
    case 'werewolf_co': return `${C.red}人狼CO${C.reset}`
    case 'fanatic_co': return `${C.red}狂信者CO${C.reset}`
    case 'werehamster_co': return `${C.magenta}妖狐CO${C.reset}`
    case 'immoralist_co': return `${C.magenta}背徳者CO${C.reset}`
    case 'submit_prediction': return '配役予想提出'
    case 'no_signal': return '沈黙'
  }
}

export function displayNewEvents(events: GameEvent[], fromIndex: number, state: GameState): number {
  if (fromIndex >= events.length) return fromIndex
  const pName = (seat: number) => state.players.find(p => p.seat === seat)?.name ?? `???`

  console.log(`\n${C.bold}--- 出来事 ---${C.reset}`)
  for (let i = fromIndex; i < events.length; i++) {
    const e = events[i]
    switch (e.type) {
      case 'night_kill':
        console.log(`  ${C.red}${pName(e.target)} が無残な姿で発見された${C.reset}`)
        break
      case 'fox_kill':
        console.log(`  ${C.magenta}${pName(e.target)} が呪殺された${C.reset}`)
        break
      case 'peace':
        console.log(`  ${C.green}平和な朝を迎えた${C.reset}`)
        break
      case 'seer_claim':
        console.log(`  ${pName(e.actor)} が${C.cyan}占い師CO${C.reset}: ${e.results.map(r => `${pName(r.target)}=${r.result === 'human' ? '○' : '●'}`).join(', ')}`)
        break
      case 'seer_result':
        console.log(`  ${pName(e.actor)} 占い結果: ${pName(e.target)}=${e.result === 'human' ? '○' : '●'}`)
        break
      case 'medium_claim':
        console.log(`  ${pName(e.actor)} が${C.cyan}霊能者CO${C.reset}`)
        break
      case 'medium_result':
        console.log(`  ${pName(e.actor)} 霊能結果: ${e.result === 'human' ? '○' : '●'}`)
        break
      case 'bodyguard_claim':
        console.log(`  ${pName(e.actor)} が${C.cyan}狩人CO${C.reset}`)
        break
      case 'mason_claim':
        console.log(`  ${pName(e.actor)} が${C.cyan}共有者CO${C.reset} 相方:${pName(e.partner)}`)
        break
      case 'nekomata_claim':
        console.log(`  ${pName(e.actor)} が${C.cyan}猫又CO${C.reset}`)
        break
      case 'forecast':
        console.log(`  ${pName(e.actor)} 占い予告→${pName(e.target)}`)
        break
      case 'vote':
        console.log(`  ${C.dim}${pName(e.voter)} → ${pName(e.target)}${C.reset}`)
        break
      case 'revote':
        console.log(`  ${C.yellow}再投票! 候補: ${e.targets.map(s => pName(s)).join(', ')}${C.reset}`)
        break
      case 'execution':
        console.log(`  ${C.red}${C.bold}${pName(e.target)} が処刑された${C.reset}`)
        break
      case 'curse_kill':
        console.log(`  ${C.red}${pName(e.target)} が猫又の呪いで死亡${C.reset}`)
        break
      case 'follow_kill':
        console.log(`  ${C.magenta}${pName(e.target)} が後追い死亡${C.reset}`)
        break
      case 'commander_appointed':
        console.log(`  ${C.yellow}${pName(e.seat)} が指揮者に任命された${C.reset}`)
        break
      case 'proposal':
        if (e.proposal.type === 'execute_order') {
          console.log(`  ${C.yellow}指揮者命令: ${pName(e.proposal.target)} を処刑せよ${C.reset}`)
        }
        break
      case 'leadership_response':
        console.log(`  ${C.dim}${pName(e.actor)}: ${e.response === 'follow' ? '了解' : e.response === 'defy' ? '拒否' : '無応答'}${C.reset}`)
        break
      case 'signal': {
        const senderName = pName(e.actor)
        console.log(`  ${C.dim}${senderName}: ${formatSignal(e.signal, state)}${C.reset}`)
        break
      }
      case 'game_over': {
        const resultMap: Record<string, string> = {
          villager_won: `${C.green}${C.bold}村人陣営の勝利!${C.reset}`,
          werewolf_won: `${C.red}${C.bold}人狼陣営の勝利!${C.reset}`,
          werehamster_won: `${C.magenta}${C.bold}妖狐の勝利!${C.reset}`,
          draw: `${C.yellow}${C.bold}引き分け${C.reset}`,
        }
        console.log(`\n  ${resultMap[e.result]}`)
        break
      }
      case 'reveal':
        console.log(`  ${pName(e.seat)}: ${roleColor(e.role)}${roleName(e.role)}${C.reset}`)
        break
      case 'comment':
        console.log(`  ${C.dim}${e.text}${C.reset}`)
        break
      case 'grelan':
        console.log(`  ${C.yellow}(グレラン)${C.reset}`)
        break
      case 'execute_proposals':
      case 'wolf_claim':
      case 'prediction':
        break
    }
  }
  return events.length
}

export function displayAliveTargets(state: GameState, exclude?: number): void {
  const alive = state.players.filter(p => p.alive && p.seat !== exclude)
  for (const p of alive) {
    const claimed = p.claimedRole ? ` [CO:${roleName(p.claimedRole)}]` : ''
    console.log(`  ${C.bold}${p.seat}${C.reset}: ${p.name}${claimed}`)
  }
}

export function displaySignalOptions(): void {
  console.log(`  ${C.bold}シグナル種別:${C.reset}`)
  console.log(`   1: 疑い(suspicion)   2: 信頼(trust)       3: 投票意思(vote_intent)`)
  console.log(`   4: 人狼告発(wolf)    5: 妖狐告発(fox)     6: 同意(agree)`)
  console.log(`   7: 反対(disagree)    8: 指揮者推薦         9: 人狼CO要求`)
  console.log(`  10: 人狼CO           11: 狂信者CO          12: 妖狐CO`)
  console.log(`  13: 背徳者CO         14: 沈黙(skip)`)
}
