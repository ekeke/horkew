import { resolveRegulation } from '../howl/ruleset.ts'
import type { Regulation } from '../types/index.ts'

/**
 * retar 単体テスト / scenario default の Regulation。
 * 初日犠牲なし / seer 初夜は無制約。
 *
 * lupa engine 用の defaultRegulation (first-victim='random') とは別物。
 * retar scenarios は伝統的に「++ で全員 join 後すぐ Day 1 議論」 の書き味で
 * 動いてきたため、 retar 既存テスト互換のため first-victim='none' を default に据える。
 *
 * omitFirstDay は表示問題で retar 推論に影響しないため default のままで OK。
 */
export const defaultAnalyzeRegulation: Regulation = resolveRegulation({
  'general.first-victim': 'none',
  'role.seer.first-seek': 'all',
})

/**
 * 初日犠牲ありの retar Regulation。
 * lupa engine の本番ゲームと整合する 14d-neko 系のテスト・ベンチで使う。
 */
export const firstGhostAnalyzeRegulation: Regulation = resolveRegulation({
  'general.first-victim': 'random',
  'role.seer.first-seek': 'all',
})
