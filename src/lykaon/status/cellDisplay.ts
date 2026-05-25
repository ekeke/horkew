import type { EnumSpecies } from '../../types/index.ts'
import type { ClaimRow, DayAssertion } from './extract.ts'

// SummaryTable.svelte:148-154 のセル決定ロジックを純関数として抽出するためのビューモデル。
// 仕様は cellDisplay.test.ts を参照。
// 本実装は未着手 (TDD スタブ)。
//   tasks/plans: C:\Users\aklas\.claude\plans\twinkling-nibbling-snail.md Task B
//   作業: 別セッション

export type CellTarget = { seat: number, name: string }

export type CellPreviousAssertion = {
  target: CellTarget
  species: EnumSpecies
}

export type CellDisplay =
  | { kind: 'empty' }
  | {
      kind: 'assertion'
      target: CellTarget
      species: EnumSpecies | null
      forecast: boolean
      isGuard: boolean
      previousAssertions: CellPreviousAssertion[]
      isCoTiming: boolean
    }
  | { kind: 'slide-marker', slidToRoleShortName: string }
  | { kind: 'death-marker', causeOfDeathLabel: string }

export function buildCellDisplay(
  _row: ClaimRow,
  _day: number,
  _timeline: Map<number, DayAssertion>,
  _players: Map<number, string>,
): CellDisplay {
  throw new Error('buildCellDisplay: not implemented (TDD stub — see cellDisplay.test.ts)')
}
