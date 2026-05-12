/**
 * train-config.json loader。
 *
 * 各 checkpoint-base 配下の `train-config.json` を読み、`process.env` に load する。
 * 既存の SKOLLZ_* / DESIGNATION_DEBUG 等の env 読み込みコードを変更せずに、
 * config を 1 ファイルに集約する仕組み。
 *
 * 既に shell env / CLI で設定済の key は skip するため、優先順位は:
 *   shell env > train-config.json > 各 env 読み取り側の default
 *
 * フォーマット (JSON):
 *   {
 *     "SKOLLZ_WORKERS": 4,
 *     "SKOLLZ_LR": 1e-4,
 *     "SKOLLZ_PARALLEL_GPU": 1,
 *     "SKOLLZ_VILLAGE_FOX_LOSE": -3.0,
 *     ...
 *   }
 *
 * - 値の型: number / boolean / string を受ける。process.env は string のみなので
 *   String() で変換 (boolean は "true"/"false"、number は素直に "1" / "0.5" 等)。
 * - null / undefined / object / array は無視 (warn を log 出力)。
 * - top-level でない (root が object でない) JSON はエラー。
 *
 * 呼び出しタイミング: orchestrate.ts の selectStartMode (= checkpointBase 確定) 直後、
 * かつ runner / ISMCTS 等の module init (= env 参照) より前。dynamic import で
 * runner.ts を呼ぶ前に loadTrainConfig を実行することで、module 初期化時に env が反映される。
 */

import { existsSync, readFileSync } from 'node:fs'

export type TrainConfigLoadResult = {
  /** ファイルから読み込んで process.env に書き込んだ key 一覧 */
  loaded: string[]
  /** ファイルにあったが、既に process.env に値があるため skip した key 一覧 */
  skipped: string[]
  /** 値が想定外の型 (null / object / array) で無視した key 一覧 */
  invalid: string[]
  /** 読み込んだファイルのパス (存在しない場合は null) */
  path: string | null
}

/**
 * 指定 path の train-config.json を読み、process.env に load する。
 *
 * ファイル不存在は no-op (loaded/skipped/invalid=[], path=null)。
 * JSON parse エラー / 非 object root はエラーを throw する (caller が catch する想定)。
 *
 * @param path 設定ファイルのパス (絶対 / 相対どちらも可、cwd 基準)
 * @returns 読み込み結果 (log 出力用)
 */
export function loadTrainConfig(path: string): TrainConfigLoadResult {
  const result: TrainConfigLoadResult = {
    loaded: [], skipped: [], invalid: [], path: null,
  }
  if (!existsSync(path)) return result
  result.path = path
  const content = readFileSync(path, 'utf-8')
  const parsed = JSON.parse(content)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`loadTrainConfig: ${path} の JSON root は object である必要があります (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`)
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (!key) continue
    // `_` で始まる key はコメント用として skip (慣習: JSON にコメントが書けないので
    // `_comment_xxx: "..."` のように key 名で意図を残す)。
    if (key.startsWith('_')) continue
    // 受容可能な型: number / boolean / string。それ以外は invalid 扱い。
    let strValue: string
    if (typeof value === 'string') {
      strValue = value
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        result.invalid.push(key)
        continue
      }
      strValue = String(value)
    } else if (typeof value === 'boolean') {
      // env では "1" / "0" 表記が一般的だが、boolean は素直に "true" / "false" 文字列に。
      // SKOLLZ_* 系は ===, == "1" で判定する場所が多いので、boolean は数値化推奨。
      strValue = value ? '1' : '0'
    } else {
      // null / undefined / object / array
      result.invalid.push(key)
      continue
    }
    // shell env / CLI で既に設定済なら skip (= shell が優先)
    const existing = process.env[key]
    if (existing !== undefined && existing !== '') {
      result.skipped.push(key)
      continue
    }
    process.env[key] = strValue
    result.loaded.push(key)
  }
  return result
}
