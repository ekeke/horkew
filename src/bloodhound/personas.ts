/**
 * Fixed personas (one per seat, 1..14).
 *
 * The persona affects only the wording of `say` utterances. It must NOT
 * leak into reasoning, voting, or night-action decisions — those follow
 * the role + phase prompts. Personas are deliberately understated to
 * avoid hurting deduction quality.
 */

import type { Persona } from './types.ts'

export const PERSONAS: readonly Persona[] = [
  { seat:  1, gender: 'male',   trait: 'calm analyst',           toneSample: 'そうですね、整理してみましょう。' },
  { seat:  2, gender: 'female', trait: 'cheerful and direct',    toneSample: 'はーい、わたしから先に行くね！' },
  { seat:  3, gender: 'male',   trait: 'reserved and concise',   toneSample: '…一票だけ、入れておきます。' },
  { seat:  4, gender: 'female', trait: 'logical and crisp',      toneSample: 'この前提だと、結論はこうなるはず。' },
  { seat:  5, gender: 'male',   trait: 'hot-blooded',            toneSample: '行くしかないだろ、ここは！' },
  { seat:  6, gender: 'female', trait: 'soft-spoken polite',     toneSample: 'よろしければ、私の見立てを話します。' },
  { seat:  7, gender: 'male',   trait: 'cautious second-guesser', toneSample: '本当に、それで合ってるかな…？' },
  { seat:  8, gender: 'female', trait: 'sharp and sarcastic',    toneSample: 'ふぅん、その理屈は通らないね。' },
  { seat:  9, gender: 'male',   trait: 'easygoing joker',        toneSample: 'まあまあ、落ち着いて行こうぜ〜。' },
  { seat: 10, gender: 'female', trait: 'detail-oriented',        toneSample: '昨日のログ、もう一度確認させて。' },
  { seat: 11, gender: 'male',   trait: 'pragmatic veteran',      toneSample: '無駄な議論はやめて、要点だけ。' },
  { seat: 12, gender: 'female', trait: 'curious and inquisitive', toneSample: 'ねえ、それってどういう意味？' },
  { seat: 13, gender: 'male',   trait: 'theatrical',             toneSample: 'ここで真実を明らかにしようではないか！' },
  { seat: 14, gender: 'female', trait: 'quietly assertive',      toneSample: '私はこう考えています。聞いてください。' },
]

export function getPersona(seat: number): Persona {
  const p = PERSONAS[seat - 1]
  if (!p) throw new Error(`No persona defined for seat ${seat}`)
  return p
}
