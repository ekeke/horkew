import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { SystemRole, EnumSpecies } from '../../types/index.ts'
import type { NightAction, DayClaim } from '../types.ts'
import type { CommunicationAction, Signal } from '../communication.ts'
import type { Proposal, LeadershipResponse } from '../leadership.ts'
import type { AsyncStrategy, DecisionContext } from '../strategy.ts'
import {
  displayPhaseHeader, displayPlayerList, displayPrivateKnowledge,
  displayRetarSummary, displayNewEvents, displayAliveTargets,
  displaySignalOptions, roleName,
} from './display.ts'

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
} as const

export class HumanCliStrategy implements AsyncStrategy {
  private rl: ReturnType<typeof createInterface> | null = null
  private eventCursor = 0
  private lastPhase: string = ''
  private humanSeat = -1
  private closed = false

  private getRL(): ReturnType<typeof createInterface> {
    if (!this.rl || this.closed) {
      this.closed = false
      this.rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY ?? false })
      this.rl.on('close', () => { this.closed = true })
    }
    return this.rl
  }

  setSeat(seat: number): void {
    this.humanSeat = seat
  }

  close(): void {
    this.rl?.close()
    this.rl = null
    this.closed = true
  }

  getEventCursor(): number {
    return this.eventCursor
  }

  private async prompt(question: string): Promise<string> {
    const rl = this.getRL()
    try {
      return await rl.question(`${C.cyan}${C.bold}> ${question}${C.reset} `)
    } catch (err) {
      // readline closed (EOF or error) — exit gracefully
      console.log('\n(入力終了)')
      process.exit(0)
    }
  }

  private async promptNumber(question: string, min: number, max: number): Promise<number> {
    while (true) {
      const answer = await this.prompt(`${question} (${min}-${max})`)
      const n = parseInt(answer.trim(), 10)
      if (!isNaN(n) && n >= min && n <= max) return n
      console.log(`  ${min}から${max}の数値を入力してください`)
    }
  }

  private async promptSeat(question: string, ctx: DecisionContext, excludeSelf = true): Promise<number> {
    const alive = ctx.gameState.players.filter(p => p.alive && (!excludeSelf || p.seat !== ctx.mySeat))
    displayAliveTargets(ctx.gameState, excludeSelf ? ctx.mySeat : undefined)
    while (true) {
      const answer = await this.prompt(question)
      const n = parseInt(answer.trim(), 10)
      if (alive.some(p => p.seat === n)) return n
      console.log(`  生存者の席番号を入力してください`)
    }
  }

  private showContext(ctx: DecisionContext, label: string): void {
    const phaseKey = `${ctx.day}-${ctx.phase}`
    if (phaseKey !== this.lastPhase) {
      displayPhaseHeader(ctx.day, ctx.phase)
      this.lastPhase = phaseKey
    }
    this.eventCursor = displayNewEvents(ctx.publicEvents, this.eventCursor, ctx.gameState)
    console.log(`\n${C.yellow}${C.bold}【${label}】${C.reset}`)
  }

  // ============================================================
  // 夜行動
  // ============================================================

  async decideNightAction(ctx: DecisionContext): Promise<NightAction> {
    this.showContext(ctx, '夜行動')
    displayPrivateKnowledge(ctx, ctx.gameState)

    switch (ctx.myRole) {
      case 'seer': {
        console.log(`\n  占い対象を選んでください:`)
        const target = await this.promptSeat('誰を占う?', ctx)
        return { type: 'divine', target }
      }
      case 'bodyguard': {
        console.log(`\n  護衛対象を選んでください:`)
        const target = await this.promptSeat('誰を護衛する?', ctx)
        return { type: 'guard', target }
      }
      case 'werewolf': {
        console.log(`\n  襲撃対象を選んでください:`)
        const alive = ctx.gameState.players.filter(p =>
          p.alive && p.seat !== ctx.mySeat && !(ctx.wolfTeammates?.includes(p.seat))
        )
        for (const p of alive) {
          const claimed = p.claimedRole ? ` [CO:${roleName(p.claimedRole)}]` : ''
          console.log(`  ${C.bold}${p.seat}${C.reset}: ${p.name}${claimed}`)
        }
        while (true) {
          const answer = await this.prompt('誰を襲撃する?')
          const n = parseInt(answer.trim(), 10)
          if (alive.some(p => p.seat === n)) return { type: 'attack', target: n }
          console.log(`  有効な対象を選んでください`)
        }
      }
      default:
        console.log(`  (行動なし)`)
        return { type: 'none' }
    }
  }

  // ============================================================
  // 昼CO
  // ============================================================

  async decideDayClaim(ctx: DecisionContext): Promise<DayClaim> {
    this.showContext(ctx, 'CO (カミングアウト)')
    displayPlayerList(ctx.gameState, this.humanSeat)
    displayPrivateKnowledge(ctx, ctx.gameState)
    displayRetarSummary(ctx, ctx.gameState)

    const options: Array<{ label: string, value: () => Promise<DayClaim> | DayClaim }> = []

    // 真役職CO
    switch (ctx.myRole) {
      case 'seer':
        if (ctx.myPlayer.claimedRole === 'seer') {
          // 既にCO済み → 結果報告
          const lastDivine = ctx.myPlayer.divineHistory.get(ctx.day - 1)
          if (lastDivine) {
            const pName = ctx.gameState.players.find(p => p.seat === lastDivine.target)?.name
            options.push({
              label: `占い結果報告: ${pName}=${lastDivine.result === 'human' ? '○' : '●'}`,
              value: () => ({ type: 'seer_result', target: lastDivine.target, result: lastDivine.result }),
            })
          }
        } else {
          options.push({
            label: '占い師CO (全結果公開)',
            value: () => {
              const results = Array.from(ctx.myPlayer.divineHistory.values()).map(d => ({ target: d.target, result: d.result }))
              return { type: 'seer_co', results }
            },
          })
        }
        break
      case 'medium':
        if (ctx.myPlayer.claimedRole === 'medium') {
          if (ctx.lastExecutedSeat !== null) {
            const executed = ctx.gameState.players.find(p => p.seat === ctx.lastExecutedSeat)!
            const result: EnumSpecies = ['werewolf'].includes(executed.role) ? 'wolf' : 'human'
            const pName = executed.name
            options.push({
              label: `霊能結果報告: ${pName}=${result === 'human' ? '○' : '●'}`,
              value: () => ({ type: 'medium_result', result }),
            })
          }
        } else {
          options.push({
            label: '霊能者CO',
            value: () => ({ type: 'medium_co' }),
          })
        }
        break
      case 'bodyguard':
        if (!ctx.myPlayer.claimedRole) {
          options.push({
            label: '狩人CO',
            value: () => {
              const targets = Array.from(ctx.myPlayer.guardHistory.values())
              return { type: 'bodyguard_co', targets }
            },
          })
        }
        break
      case 'mason':
        if (!ctx.myPlayer.claimedRole && ctx.masonPartner !== null) {
          const partnerName = ctx.gameState.players.find(p => p.seat === ctx.masonPartner)?.name
          options.push({
            label: `共有者CO (相方: ${partnerName})`,
            value: () => ({ type: 'mason_co', partner: ctx.masonPartner! }),
          })
        }
        break
      case 'nekomata':
        if (!ctx.myPlayer.claimedRole) {
          options.push({
            label: '猫又CO',
            value: () => ({ type: 'nekomata_co' }),
          })
        }
        break
    }

    // 偽CO (人外陣営)
    const fakeable: SystemRole[] = ['werewolf', 'possessed', 'fanatic', 'werehamster', 'immoralist']
    if (fakeable.includes(ctx.myRole)) {
      if (!ctx.myPlayer.claimedRole) {
        options.push({
          label: '偽占い師CO',
          value: async () => {
            const results: Array<{ target: number, result: EnumSpecies }> = []
            // 偽結果を構築
            for (const [, d] of ctx.myPlayer.fakeDivineHistory) {
              results.push({ target: d.target, result: d.result })
            }
            if (results.length === 0) {
              console.log('  偽結果を作成します:')
              const alive = ctx.gameState.players.filter(p => p.alive && p.seat !== ctx.mySeat)
              for (let night = 0; night < ctx.day; night++) {
                console.log(`  ${night}夜の偽占い対象:`)
                for (const p of alive) console.log(`    ${p.seat}: ${p.name}`)
                const target = await this.promptSeat(`${night}夜の対象?`, ctx)
                const r = await this.prompt('結果? (1: ○人間, 2: ●人狼)')
                const result: EnumSpecies = r.trim() === '2' ? 'wolf' : 'human'
                results.push({ target, result })
              }
            }
            return { type: 'seer_co', results }
          },
        })
        options.push({
          label: '偽霊能者CO',
          value: () => ({ type: 'medium_co' }),
        })
      }
    }

    options.push({
      label: 'COしない',
      value: () => ({ type: 'none' }),
    })

    console.log(`\n  選択肢:`)
    for (let i = 0; i < options.length; i++) {
      console.log(`  ${C.bold}${i + 1}${C.reset}: ${options[i].label}`)
    }

    const choice = await this.promptNumber('選択', 1, options.length)
    return options[choice - 1].value()
  }

  // ============================================================
  // 予告
  // ============================================================

  async decideForecast(ctx: DecisionContext): Promise<DayClaim> {
    if (ctx.myPlayer.claimedRole !== 'seer') return { type: 'none' }

    this.showContext(ctx, '占い予告')
    console.log(`  予告しますか? (占い対象の事前宣言)`)
    const answer = await this.prompt('予告する? (y/n)')
    if (answer.trim().toLowerCase() !== 'y') return { type: 'none' }

    const target = await this.promptSeat('誰を予告する?', ctx)
    return { type: 'forecast', target }
  }

  // ============================================================
  // コミュニケーション
  // ============================================================

  async decideCommunication(ctx: DecisionContext): Promise<CommunicationAction> {
    this.showContext(ctx, 'シグナル')
    displaySignalOptions()

    const signalChoice = await this.promptNumber('シグナル', 1, 14)

    let signal: Signal
    const targetSignals = [1, 2, 3, 4, 5, 6, 7, 8]
    if (targetSignals.includes(signalChoice)) {
      const target = await this.promptSeat('対象', ctx)
      const typeMap: Record<number, Signal['type']> = {
        1: 'suspicion', 2: 'trust', 3: 'vote_intent', 4: 'accuse_wolf',
        5: 'accuse_fox', 6: 'agree', 7: 'disagree', 8: 'nominate_commander',
      }
      signal = { type: typeMap[signalChoice], target } as Signal
    } else {
      const typeMap: Record<number, Signal['type']> = {
        9: 'demand_wolf_co', 10: 'werewolf_co', 11: 'fanatic_co',
        12: 'werehamster_co', 13: 'immoralist_co', 14: 'no_signal',
      }
      signal = { type: typeMap[signalChoice] } as Signal
    }

    // 処刑提案
    console.log(`\n  処刑提案 (カンマ区切りで席番号、なしならEnter):`)
    displayAliveTargets(ctx.gameState, ctx.mySeat)
    const propAnswer = await this.prompt('提案')
    const proposals = propAnswer.trim()
      ? propAnswer.trim().split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
      : []

    return { signal, proposals }
  }

  // ============================================================
  // 投票
  // ============================================================

  async decideVote(ctx: DecisionContext): Promise<number> {
    this.showContext(ctx, '投票')
    displayPlayerList(ctx.gameState, this.humanSeat)
    displayRetarSummary(ctx, ctx.gameState)

    if (ctx.revoteCandidates) {
      console.log(`\n  ${C.yellow}再投票 (第${ctx.revoteRound}回) — 候補者:${C.reset}`)
      for (const seat of ctx.revoteCandidates) {
        const p = ctx.gameState.players.find(pp => pp.seat === seat)!
        const claimed = p.claimedRole ? ` [CO:${roleName(p.claimedRole)}]` : ''
        console.log(`  ${C.bold}${p.seat}${C.reset}: ${p.name}${claimed}`)
      }
      while (true) {
        const answer = await this.prompt('誰に投票する?')
        const n = parseInt(answer.trim(), 10)
        if (ctx.revoteCandidates.includes(n)) return n
        console.log(`  候補者の中から選んでください`)
      }
    }

    console.log(`\n  投票対象を選んでください:`)
    return this.promptSeat('誰に投票する?', ctx)
  }

  // ============================================================
  // 指揮者提案
  // ============================================================

  async decideProposal(ctx: DecisionContext): Promise<Proposal | null> {
    this.showContext(ctx, '指揮者提案')
    console.log(`  あなたは指揮者です。処刑命令を出しますか?`)
    const answer = await this.prompt('命令を出す? (y/n)')
    if (answer.trim().toLowerCase() !== 'y') return null

    const target = await this.promptSeat('処刑対象', ctx)
    return { type: 'execute_order', target }
  }

  // ============================================================
  // 指揮者への応答
  // ============================================================

  async decideLeadershipResponse(ctx: DecisionContext, proposal: Proposal): Promise<LeadershipResponse> {
    this.showContext(ctx, '指揮者命令への応答')
    if (proposal.type === 'execute_order') {
      const targetName = ctx.gameState.players.find(p => p.seat === proposal.target)?.name
      console.log(`  指揮者命令: ${targetName}(${proposal.target}) を処刑せよ`)
    }
    console.log(`  1: 了解(follow)  2: 拒否(defy)  3: 無応答`)
    const choice = await this.promptNumber('選択', 1, 3)
    return ['follow', 'defy', 'no_response'][choice - 1] as LeadershipResponse
  }

  // ============================================================
  // 防御CO
  // ============================================================

  async decideDefensiveClaim(ctx: DecisionContext): Promise<DayClaim> {
    if (ctx.myPlayer.claimedRole !== null) return { type: 'none' }

    this.showContext(ctx, '防御CO')
    console.log(`  ${C.yellow}あなたは処刑提案の対象です! COしますか?${C.reset}`)
    return this.decideDayClaim(ctx)
  }
}
