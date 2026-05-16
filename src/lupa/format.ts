import type { SystemRole } from '../types/index.ts'
import type { LupaConfig, GameState } from './types.ts'

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

// 配役記法用の短縮表記（パーサーのvocabulary最短形に合わせる）
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
  draw: '引き分け',
} as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts GameEvent | FenrirExtEvent; full typing deferred to Phase 2
export function formatHowl(events: readonly any[], state: GameState, config: LupaConfig): string {
  const lines: string[] = []
  const playerName = (seat: number) => state.players.find(p => p.seat === seat)!.name

  // 配役
  const setupParts = Array.from(config.roles.entries())
    .map(([role, count]) => `${ROLE_SETUP_DISPLAY[role]}${count}`)
    .join(' ')
  lines.push(`配役 ${setupParts}`)
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
  // medium_result の target（直近処刑席）を追跡。GameEvent.medium_result は target を持たない
  // ため、execution 時点の seat を running state として保持し、霊能結果の target に使う
  let lastExecutedSeat: number | null = null

  for (const event of events) {
    switch (event.type) {
      case 'comment': {
        if (lastType !== 'comment') {
          lines.push('')
        }
        lines.push(`# ${event.text}`)
        break
      }
      case 'speech': {
        lines.push(`${playerName(event.actor)} > ${event.text}`)
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
          .map((r: any) => `${r.day + 1}D ${playerName(r.target)}${r.result === 'human' ? '○' : '●'}`)
          .join(' ')
        lines.push(`${playerName(event.actor)} 占いCO${resultsStr ? ' ' + resultsStr : ''}`)
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
        const pastStr = event.pastResults && event.pastResults.length > 0
          ? ' ' + event.pastResults.map((r: any) => r === 'human' ? '○' : '●').join(' ')
          : ''
        lines.push(`${playerName(event.actor)} 霊能CO${pastStr}`)
        break
      }
      case 'medium_result': {
        if (lastType === 'night_kill' || lastType === 'fox_kill' || lastType === 'peace') {
          lines.push('')
        }
        const targetName = lastExecutedSeat !== null ? playerName(lastExecutedSeat) : '?'
        lines.push(`${playerName(event.actor)} ${targetName}${event.result === 'human' ? '○' : '●'}`)
        break
      }
      case 'bodyguard_claim': {
        if (lastType === 'night_kill' || lastType === 'fox_kill' || lastType === 'peace') {
          lines.push('')
        }
        const guardsStr = event.targets.map((t: any) => `${playerName(t)}護衛`).join(' ')
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
      case 'grelan': {
        lines.push('')
        lines.push('グレラン')
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
        const targetNames = event.targets.map((t: any) => playerName(t)).join('、')
        lines.push(`再投票 ${targetNames}`)
        break
      }
      case 'execution': {
        lines.push('')
        lines.push(`${playerName(event.target)}処刑`)
        lastExecutedSeat = event.target
        break
      }
      case 'game_over': {
        lines.push('')
        lines.push(RESULT_DISPLAY[event.result as keyof typeof RESULT_DISPLAY])
        break
      }
      case 'reveal': {
        if (lastType === 'game_over') {
          lines.push('')
        }
        lines.push(`${playerName(event.seat)}＝${ROLE_DISPLAY[event.role as SystemRole]}`)
        break
      }
      case 'signal': {
        const sig = event.signal
        let sigText: string
        switch (sig.type) {
          case 'suspicion': sigText = `${playerName(event.actor)} → ${playerName(sig.target)} 疑い`; break
          case 'trust': sigText = `${playerName(event.actor)} → ${playerName(sig.target)} 信頼`; break
          case 'vote_intent': sigText = `${playerName(event.actor)} → ${playerName(sig.target)} 投票意思`; break
          case 'accuse_wolf': sigText = `${playerName(event.actor)} → ${playerName(sig.target)} 狼告発`; break
          case 'accuse_fox': sigText = `${playerName(event.actor)} → ${playerName(sig.target)} 狐告発`; break
          case 'agree': sigText = `${playerName(event.actor)} → ${playerName(sig.target)} 同意`; break
          case 'disagree': sigText = `${playerName(event.actor)} → ${playerName(sig.target)} 反対`; break
          case 'nominate_commander': sigText = `${playerName(event.actor)} → ${playerName(sig.target)} 指揮者推薦`; break
          case 'demand_wolf_co': sigText = `${playerName(event.actor)} 狼CO要求`; break
          case 'werewolf_co': sigText = `${playerName(event.actor)} 人狼CO`; break
          case 'fanatic_co': sigText = `${playerName(event.actor)} 狂信者CO`; break
          case 'werehamster_co': sigText = `${playerName(event.actor)} 妖狐CO`; break
          case 'immoralist_co': sigText = `${playerName(event.actor)} 背徳者CO`; break
          case 'submit_prediction': sigText = `${playerName(event.actor)} 配役予想提出`; break
          default: sigText = ''; break  // no_signal は出力しない
        }
        if (sigText) lines.push(`# [シグナル] ${sigText}`)
        break
      }
      case 'wolf_claim': {
        lines.push(`${playerName(event.actor)} ${ROLE_DISPLAY[event.claimedRole as SystemRole]}CO`)
        break
      }
      case 'execute_proposals': {
        const targets = event.targets.map((t: any) => playerName(t)).join(', ')
        lines.push(`# [提案] ${playerName(event.actor)} → ${targets} 処刑提案`)
        break
      }
      case 'prediction': {
        const parts: string[] = []
        for (const [seat, roles] of event.predictions) {
          parts.push(`${playerName(seat)}=${roles.map((r: any) => ROLE_DISPLAY[r as SystemRole]).join('/')}`)
        }
        lines.push(`# [予想] ${playerName(event.actor)}: ${parts.join(', ')}`)
        break
      }
      case 'vote_decisions': {
        const parts = event.decisions.map((d: any) => `${playerName(d.seat)}=${d.reason}`)
        lines.push(`# [投票根拠] ${parts.join(', ')}`)
        break
      }
      case 'plan_commit': {
        const parts: string[] = []
        if (event.forward) parts.push(`forward: ${event.forward}`)
        if (event.endgame) parts.push(`endgame: ${event.endgame}`)
        if (parts.length > 0) {
          lines.push(`# [プラン] ${playerName(event.actor)} ${parts.join(' | ')}`)
        }
        break
      }
      case 'commander_appointed':
      case 'proposal':
      case 'leadership_response':
        break
    }

    lastType = event.type
  }

  lines.push('')
  return lines.join('\n')
}
