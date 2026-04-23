/**
 * GameResult / GameEvent[] を Howl 形式文字列に変換する。
 *
 * GameEvent → Howl Statement への**意味マッピング**のみをここで行い、
 * 文字列整形は `src/howl/serialize.ts` に委譲する。Howl の表記ルール
 * （矢印記号、CO ラベル、種族記号 ●○ など）は Lupa 側では一切持たない。
 *
 * デバッグ、シナリオテスト用データ、ベンチからのゲーム記録などで使用する。
 */

import type { SystemRole } from '../types/index.ts'
import type { GameResult } from './handlers.ts'
import type { GameEvent, PlayerState } from './types.ts'
import type { Statement, Species, GameResult as HowlGameResult } from '../howl/statement.ts'
import {
  serializeStatement, commentLine,
  makeSetup, makeJoin, makeVote, makeRevote, makeGrelan,
  makeAttack, makeLynch, makePeace, makeCurse, makeFollow,
  makeForecast, makeOver, makeReveal,
  makeSeerCO, makeSeerResult, makeMediumCO, makeMediumResult,
  makeBodyguardCO, makeMasonCO, makeNekomataCO,
} from '../howl/index.ts'

export type HowlExportOptions = {
  /** frontmatter の title */
  title?: string
  /** seat → 表示名のマップ（未指定座席は "P<seat>" フォールバック） */
  seatNames?: Map<number, string>
  /** frontmatter に追加するキー/値（文字列化される） */
  frontmatter?: Record<string, string | number | boolean>
  /** 真役職をコメントとして書き出す（デフォルト true） */
  includeRoles?: boolean
  /** @expect アノテーションを末尾に書き出す（デフォルト true） */
  includeExpect?: boolean
}

function speciesOf(r: 'wolf' | 'human' | null): Species | null {
  if (r === 'wolf') return 'isWolf'
  if (r === 'human') return 'isHuman'
  return null
}

function howlResultOf(r: GameResult<unknown, unknown>['state']['result']): HowlGameResult {
  switch (r) {
    case 'villager_won': return 'villageWin'
    case 'werewolf_won': return 'wolfWin'
    case 'werehamster_won': return 'hamsterWin'
    default: return 'draw'
  }
}

/**
 * 単一イベントを 0 件以上の出力行に変換する。
 * Statement に写せるものは Statement を返し、写せないものは `# ...` コメント行を返す。
 * 直接不要なイベント（fox_kill など）は空配列を返してもよい。
 */
function eventToLines(
  ev: GameEvent,
  name: (seat: number) => string,
  ctx: { lastExecuted: number | null },
): string[] {
  switch (ev.type) {
    case 'vote':
      return [serializeStatement(makeVote(name(ev.voter), name(ev.target)))]

    case 'revote':
      return [serializeStatement(makeRevote(ev.targets.map(name)))]

    case 'grelan':
      return [serializeStatement(makeGrelan())]

    case 'execution':
      // 処刑者を記録して後続の medium_result の target に使う
      ctx.lastExecuted = ev.target
      return [serializeStatement(makeLynch(name(ev.target)))]

    case 'night_kill':
      return [serializeStatement(makeAttack([name(ev.target)]))]

    case 'peace':
      return [serializeStatement(makePeace())]

    case 'curse_kill':
      return [serializeStatement(makeCurse(name(ev.target)))]

    case 'follow_kill':
      return [serializeStatement(makeFollow(name(ev.target)))]

    case 'seer_claim': {
      const results = ev.results
        .map(r => ({ day: r.day, target: name(r.target), result: speciesOf(r.result) }))
        .filter((r): r is { day: number; target: string; result: Species } => r.result !== null)
      return [serializeStatement(makeSeerCO(name(ev.actor), results))]
    }

    case 'seer_result': {
      const sp = speciesOf(ev.result)
      if (sp === null) return []
      return [serializeStatement(makeSeerResult(name(ev.actor), name(ev.target), sp))]
    }

    case 'medium_claim': {
      // pastResults は時系列順だが対応する処刑者がここには無い。
      // Howl AssertStatement は target 必須のため、暫定 '?' を置く。
      const results = (ev.pastResults ?? [])
        .map(r => ({ target: '?', result: speciesOf(r) }))
        .filter((r): r is { target: string; result: Species } => r.result !== null)
      return [serializeStatement(makeMediumCO(name(ev.actor), results))]
    }

    case 'medium_result': {
      const sp = speciesOf(ev.result)
      if (sp === null) return []
      const target = ctx.lastExecuted !== null ? name(ctx.lastExecuted) : '?'
      return [serializeStatement(makeMediumResult(name(ev.actor), target, sp))]
    }

    case 'bodyguard_claim':
      return [serializeStatement(makeBodyguardCO(name(ev.actor), ev.targets.map(name)))]

    case 'mason_claim':
      // 共有CO。Howl の assert には partner 情報が乗らないためコメントで補足。
      return [
        serializeStatement(makeMasonCO(name(ev.actor))),
        commentLine(`${name(ev.actor)} 共有パートナー=${name(ev.partner)}`),
      ]

    case 'nekomata_claim':
      return [serializeStatement(makeNekomataCO(name(ev.actor)))]

    case 'forecast':
      return [serializeStatement(makeForecast(name(ev.actor), name(ev.target)))]

    case 'comment':
      return [commentLine(ev.text)]

    case 'game_over':
      return [serializeStatement(makeOver(howlResultOf(ev.result)))]

    case 'reveal':
      return [serializeStatement(makeReveal(name(ev.seat), ev.role))]

    case 'fox_kill':
      return [commentLine(`${name(ev.target)} 妖狐（噛み無効）`)]
  }
}

/**
 * GameResult を Howl 形式の文字列に変換する。
 *
 * 出力構造:
 * 1. frontmatter (YAML)
 * 2. レギュ 行（SetupStatement を serialize）
 * 3. プレイヤーリスト（JoinStatement を serialize）
 * 4. 真役職コメント（option）
 * 5. イベント列（処刑・噛み・平和の後に空行を挿入）
 * 6. @expect アノテーション（option）
 */
export function gameToHowl<E, Ext>(
  result: GameResult<E, Ext>,
  opts: HowlExportOptions = {},
): string {
  const { state, events, config } = result
  const includeRoles = opts.includeRoles ?? true
  const includeExpect = opts.includeExpect ?? true

  const seatName = (seat: number): string => opts.seatNames?.get(seat) ?? `P${seat}`

  const lines: string[] = []

  // ---- frontmatter ----
  lines.push('---')
  if (opts.title) lines.push(`title: ${opts.title}`)
  if (state.result != null) lines.push(`result: ${state.result}`)
  if (opts.frontmatter) {
    for (const [k, v] of Object.entries(opts.frontmatter)) {
      lines.push(`${k}: ${v}`)
    }
  }
  lines.push('---')

  // ---- setup ----
  const setupRoles: Record<string, number> = {}
  for (const [role, count] of config.roles as Map<SystemRole, number>) {
    setupRoles[role] = count
  }
  lines.push(serializeStatement(makeSetup(setupRoles)))
  lines.push('')

  // ---- players ----
  for (const p of state.players as PlayerState[]) {
    lines.push(serializeStatement(makeJoin(seatName(p.seat))))
  }
  lines.push('')

  // ---- 真役職（option） ----
  if (includeRoles) {
    lines.push(commentLine('真役職:'))
    for (const p of state.players as PlayerState[]) {
      lines.push(commentLine(`  ${seatName(p.seat)}: ${p.role}`))
    }
    lines.push('')
  }

  // ---- イベント列 ----
  const emitCtx = { lastExecuted: null as number | null }
  let prevWasTerminal = false

  for (const ev of events as (GameEvent | E)[]) {
    if (typeof (ev as { type?: unknown }).type !== 'string') continue
    const gev = ev as GameEvent

    const emitted = eventToLines(gev, seatName, emitCtx)
    const isTerminal = gev.type === 'execution' || gev.type === 'night_kill' || gev.type === 'peace'

    if (prevWasTerminal) {
      lines.push('')
      prevWasTerminal = false
    }
    for (const line of emitted) lines.push(line)
    if (isTerminal) prevWasTerminal = true
  }

  // ---- @expect ----
  if (includeExpect) {
    lines.push('')
    lines.push(commentLine('@expect annotations (参考):'))
    for (const p of state.players as PlayerState[]) {
      lines.push(`# @expect ${seatName(p.seat)}: [${p.role}]`)
    }
  }

  return lines.join('\n')
}

/** 将来 Statement 列ベースの API を使いたい呼び出し側のために残す薄いラッパー。 */
export function statementsToString(stmts: Statement[]): string {
  return stmts.map(serializeStatement).join('\n')
}
