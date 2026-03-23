import type { SystemRole } from '../types/index.ts'
import type { LupaConfig, GameEvent, GameState } from './types.ts'

const ROLE_DISPLAY: Record<SystemRole, string> = {
  villager: '村',
  seer: '占い',
  medium: '霊',
  bodyguard: '狩り',
  mason: '共有',
  nekomata: '猫',
  werewolf: '人狼',
  possessed: '狂人',
  fanatic: '狂信',
  werehamster: '狐',
  immoralist: '背徳',
}

// @記法用の短縮表記（パーサーのvocabulary最短形に合わせる）
const ROLE_SETUP_DISPLAY: Record<SystemRole, string> = {
  villager: '村',
  seer: '占',
  medium: '霊',
  bodyguard: '狩',
  mason: '共',
  nekomata: '猫',
  werewolf: '狼',
  possessed: '狂',
  fanatic: '信',
  werehamster: '狐',
  immoralist: '背',
}

const RESULT_DISPLAY = {
  villager_won: '村勝利',
  werewolf_won: '狼勝利',
  werehamster_won: '狐勝利',
} as const

export function formatHowl(events: GameEvent[], state: GameState, config: LupaConfig): string {
  const lines: string[] = []
  const playerName = (seat: number) => state.players.find(p => p.seat === seat)!.name

  // 配役（@記法）
  const setupParts = Array.from(config.roles.entries())
    .map(([role, count]) => `${ROLE_SETUP_DISPLAY[role]}${count}`)
    .join(' ')
  lines.push(`@ ${setupParts}`)
  lines.push('')

  // シード値
  if (config.seed !== undefined) {
    lines.push(`# seed: ${config.seed}`)
  }

  // プレイヤー一覧
  const names = state.players.map(p => p.name).join('、')
  lines.push(`++${names}`)

  // イベント出力
  let lastType: string | null = null

  for (const event of events) {
    switch (event.type) {
      case 'comment': {
        if (lastType !== 'comment') {
          lines.push('')
        }
        lines.push(`# ${event.text}`)
        break
      }
      case 'night_kill':
      case 'fox_kill': {
        if (lastType !== 'night_kill' && lastType !== 'fox_kill' && lastType !== 'comment') {
          lines.push('')
        }
        lines.push(`${playerName(event.target)} 死亡`)
        break
      }
      case 'peace': {
        lines.push('')
        lines.push('平和')
        break
      }
      case 'seer_claim': {
        if (lastType === 'night_kill' || lastType === 'fox_kill' || lastType === 'peace') {
          lines.push('')
        }
        const resultsStr = event.results
          .map(r => `${playerName(r.target)}${r.result === 'human' ? '○' : '●'}`)
          .join(' ')
        lines.push(`${playerName(event.actor)} 占いCO ${resultsStr}`)
        break
      }
      case 'seer_result': {
        if (lastType === 'night_kill' || lastType === 'fox_kill' || lastType === 'peace') {
          lines.push('')
        }
        lines.push(`${playerName(event.actor)} ${playerName(event.target)}${event.result === 'human' ? '○' : '●'}`)
        break
      }
      case 'medium_claim': {
        if (lastType === 'night_kill' || lastType === 'fox_kill' || lastType === 'peace') {
          lines.push('')
        }
        lines.push(`${playerName(event.actor)} 霊能CO`)
        break
      }
      case 'medium_result': {
        if (lastType === 'night_kill' || lastType === 'fox_kill' || lastType === 'peace') {
          lines.push('')
        }
        lines.push(`${playerName(event.actor)} ${event.result === 'human' ? '○' : '●'}`)
        break
      }
      case 'bodyguard_claim': {
        if (lastType === 'night_kill' || lastType === 'fox_kill' || lastType === 'peace') {
          lines.push('')
        }
        const guardsStr = event.targets.map(t => `${playerName(t)}護衛`).join(' ')
        lines.push(`${playerName(event.actor)} 狩りCO${guardsStr ? ' ' + guardsStr : ''}`)
        break
      }
      case 'mason_claim': {
        if (lastType === 'night_kill' || lastType === 'fox_kill' || lastType === 'peace') {
          lines.push('')
        }
        lines.push(`${playerName(event.actor)} 共有CO ${playerName(event.partner)}白`)
        break
      }
      case 'nekomata_claim': {
        if (lastType === 'night_kill' || lastType === 'fox_kill' || lastType === 'peace') {
          lines.push('')
        }
        lines.push(`${playerName(event.actor)} 猫CO`)
        break
      }
      case 'forecast': {
        lines.push(`${playerName(event.actor)} 予告 ${playerName(event.target)}`)
        break
      }
      case 'curse_kill': {
        lines.push(`${playerName(event.target)} 道連れ`)
        break
      }
      case 'follow_kill': {
        lines.push(`${playerName(event.target)} 後追い`)
        break
      }
      case 'vote': {
        if (lastType !== 'vote') {
          lines.push('')
        }
        lines.push(`${playerName(event.voter)}→${playerName(event.target)}`)
        break
      }
      case 'revote': {
        lines.push('')
        const targetNames = event.targets.map(t => playerName(t)).join('、')
        lines.push(`再投票 ${targetNames}`)
        break
      }
      case 'execution': {
        lines.push('')
        lines.push(`${playerName(event.target)}処刑`)
        break
      }
      case 'game_over': {
        lines.push('')
        lines.push(RESULT_DISPLAY[event.result])
        break
      }
      case 'reveal': {
        if (lastType === 'game_over') {
          lines.push('')
        }
        lines.push(`${playerName(event.seat)}＝${ROLE_DISPLAY[event.role]}`)
        break
      }
    }

    lastType = event.type
  }

  lines.push('')
  return lines.join('\n')
}
