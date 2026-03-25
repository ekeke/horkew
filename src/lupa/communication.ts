import type { SystemRole } from '../types/index.ts'

// ============================================================
// コミュニケーションプロトコル (14D猫専用)
// ============================================================
// シグナルラウンド: 1日3ラウンド。毎ラウンド全生存者が同時に1シグナルを発信。
// 各ラウンドでは comm head (シグナル1つ) + propose head (処刑提案) を同時出力。
// submit_prediction 選択時のみ prediction head (配役予想) も有効。
//
// === comm head (softmax, 1つ選択) ===
//
// ■ target系シグナル (対象: 生存者かつ非自分)
//   suspicion(target)    — 対象を疑わしいと表明する
//   trust(target)        — 対象を信頼すると表明する
//   vote_intent(target)  — 対象に投票する意思を表明する（投票先の事前宣言）
//   accuse_wolf(target)  — 対象を人狼だと告発する
//   accuse_fox(target)   — 対象を妖狐だと告発する
//   agree(target)        — 対象の発言・行動に同意する
//   disagree(target)     — 対象の発言・行動に反対する
//
// ■ 宣言系シグナル (対象なし、常に利用可能)
//   demand_wolf_co       — 人狼にCOを要求する（村陣営の戦術）
//   werewolf_co          — 人狼COする（PP, LWCO等）
//   fanatic_co           — 狂信者COする
//   werehamster_co       — 妖狐COする（狐盾等）
//   immoralist_co        — 背徳者COする
//   submit_prediction    — 配役予想を提出する（prediction headが有効化）
//   no_signal            — 何も発信しない（沈黙も情報）
//
// === propose head (sigmoid, 複数同時選択可) ===
//   14次元。各席に対して処刑提案する/しないを独立判定。
//   霊能ローラー等、複数対象への同時提案が可能。
//
// === prediction head (sigmoid, submit_prediction時のみ有効) ===
//   14席 × 11役職 = 154次元。各席-役職ペアの予想を独立判定。
//   Retarの論理推論に社会的推理を加えた予想の表明。
// ============================================================

export type Signal =
  | { type: 'suspicion', target: number }
  | { type: 'trust', target: number }
  | { type: 'vote_intent', target: number }
  | { type: 'accuse_wolf', target: number }
  | { type: 'accuse_fox', target: number }
  | { type: 'agree', target: number }
  | { type: 'disagree', target: number }
  | { type: 'demand_wolf_co' }
  | { type: 'werewolf_co' }
  | { type: 'fanatic_co' }
  | { type: 'werehamster_co' }
  | { type: 'immoralist_co' }
  | { type: 'submit_prediction' }
  | { type: 'no_signal' }

export type SignalRecord = {
  id: number
  sender: number
  day: number
  signal: Signal
}

/** 各席に対する役職予想 (席番号 → 予想役職リスト) */
export type RolePrediction = Map<number, SystemRole[]>

/** decideCommunication の戻り値 */
export type CommunicationAction = {
  signal: Signal
  /** 処刑提案対象の席番号リスト (propose head) */
  proposals: number[]
  /** 配役予想 (prediction head, submit_prediction時のみ) */
  predictions?: RolePrediction
}
