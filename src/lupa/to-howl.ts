/**
 * GameResult / GameEvent[] を Howl 形式文字列に変換する。
 *
 * Lupa が出力する GameEvent 列は Howl 記法の構造化データと直接対応するため、
 * ここではエンジン出力を「正規の Howl 文字列」として書き出すユーティリティを提供する。
 *
 * デバッグ、シナリオテスト用データ、ベンチからのゲーム記録などで使用する。
 */

import type { SystemRole } from '../types/index.ts'
import type { GameResult } from './handlers.ts'
import type { GameEvent } from './types.ts'

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

const ROLE_LABEL: Record<SystemRole, string> = {
  villager: '村', werewolf: '狼', seer: '占', medium: '霊',
  bodyguard: '狩', mason: '共', nekomata: '猫',
  fanatic: '狂', werehamster: '狐', immoralist: '背',
  possessed: '狂人',
}

const ROLE_ORDER: SystemRole[] = [
  'villager', 'werewolf', 'seer', 'medium', 'bodyguard',
  'mason', 'nekomata', 'fanatic', 'werehamster', 'immoralist', 'possessed',
]

function speciesGlyph(result: 'wolf' | 'human' | null): string {
  if (result === 'wolf') return '●'
  if (result === 'human') return '○'
  return '?'
}

function formatSetup(roles: Map<SystemRole, number>): string {
  return ROLE_ORDER
    .filter(r => (roles.get(r) ?? 0) > 0)
    .map(r => `${ROLE_LABEL[r]}${roles.get(r)}`)
    .join('')
}

/**
 * 単一イベントを1行以上の Howl 文字列に変換し、`out` に push する。
 * 拡張イベント（`type` が既知でないもの）は黙って無視する。
 */
function emitEvent(ev: GameEvent, name: (seat: number) => string, out: string[]): void {
  switch (ev.type) {
    case 'vote':
      out.push(`${name(ev.voter)}→${name(ev.target)}`)
      break
    case 'revote':
      out.push(`ーーー  # 再投票候補: ${ev.targets.map(name).join(', ')}`)
      break
    case 'grelan':
      out.push('グレラン')
      break
    case 'execution':
      out.push(`${name(ev.target)}処刑`)
      break
    case 'night_kill':
      out.push(`${name(ev.target)}噛み`)
      break
    case 'fox_kill':
      out.push(`# ${name(ev.target)} 妖狐（噛み無効）`)
      break
    case 'peace':
      out.push('平和')
      break
    case 'curse_kill':
      out.push(`# ${name(ev.target)} 呪殺`)
      break
    case 'follow_kill':
      out.push(`# ${name(ev.target)} 後追い`)
      break
    case 'seer_claim': {
      const results = ev.results.map(r => `${name(r.target)}${speciesGlyph(r.result)}`).join(' ')
      out.push(`${name(ev.actor)} 占いCO${results ? ' ' + results : ''}`)
      break
    }
    case 'seer_result':
      out.push(`${name(ev.actor)} ${name(ev.target)}${speciesGlyph(ev.result)}`)
      break
    case 'medium_claim': {
      const past = (ev.pastResults ?? []).map(speciesGlyph).join(' ')
      out.push(`${name(ev.actor)} 霊媒CO${past ? ' ' + past : ''}`)
      break
    }
    case 'medium_result':
      out.push(`${name(ev.actor)} 霊能 ${speciesGlyph(ev.result)}`)
      break
    case 'bodyguard_claim':
      out.push(`${name(ev.actor)} 狩人CO${ev.targets.length > 0 ? ' 護衛: ' + ev.targets.map(name).join(',') : ''}`)
      break
    case 'mason_claim':
      out.push(`${name(ev.actor)} 共有CO partner=${name(ev.partner)}`)
      break
    case 'nekomata_claim':
      out.push(`${name(ev.actor)} 猫又CO`)
      break
    case 'forecast':
      out.push(`# ${name(ev.actor)} 予告 → ${name(ev.target)}`)
      break
    case 'comment':
      out.push(`# ${ev.text}`)
      break
    case 'game_over':
      out.push(`# ゲーム終了: ${ev.result}`)
      break
    case 'reveal':
      out.push(`# ${name(ev.seat)} reveal=${ev.role}`)
      break
  }
}

/**
 * GameResult を Howl 形式の文字列に変換する。
 *
 * 出力構造:
 * 1. frontmatter (YAML)
 * 2. レギュレーション
 * 3. プレイヤー名リスト (`+ name`)
 * 4. 真役職のコメント（option）
 * 5. イベント列（処刑・噛みで空行区切り）
 * 6. @expect アノテーション末尾（option）
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
  lines.push(`レギュ ${formatSetup(config.roles)}`)
  lines.push('')

  // ---- player list ----
  for (const p of state.players) {
    lines.push(`+ ${seatName(p.seat)}`)
  }
  lines.push('')

  // ---- 真役職（option） ----
  if (includeRoles) {
    lines.push('# 真役職:')
    for (const p of state.players) {
      lines.push(`#   ${seatName(p.seat)}: ${p.role}`)
    }
    lines.push('')
  }

  // ---- イベント列 ----
  // 処刑・噛み・平和の後に空行を入れて日単位の視認性を確保する
  let prevWasTerminal = false
  for (const ev of events as (GameEvent | E)[]) {
    // 拡張イベント (E) は無視（Lupa標準以外のハンドラ内部情報）
    if (typeof (ev as any).type !== 'string') continue
    const gev = ev as GameEvent

    if (gev.type === 'execution') {
      emitEvent(gev, seatName, lines)
      prevWasTerminal = true
      continue
    }
    if (gev.type === 'night_kill' || gev.type === 'peace') {
      emitEvent(gev, seatName, lines)
      lines.push('')
      prevWasTerminal = true
      continue
    }
    if (prevWasTerminal) {
      lines.push('')
      prevWasTerminal = false
    }
    emitEvent(gev, seatName, lines)
  }

  // ---- @expect アノテーション ----
  if (includeExpect) {
    lines.push('')
    lines.push('# @expect annotations (参考):')
    for (const p of state.players) {
      lines.push(`# @expect ${seatName(p.seat)}: [${p.role}]`)
    }
  }

  return lines.join('\n')
}
