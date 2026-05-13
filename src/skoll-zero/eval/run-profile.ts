/**
 * skoll-zero の実行プロファイル: 「学習」と「eval (= 自己対戦評価)」の 2 種類のみ。
 *
 * - training: self-play で trajectory を集めて PPO 学習する経路 (sample 選択)
 * - eval: 学習中の eval ループ ([phase/runner.ts] の runEvalSession) と
 *         self-play-howl CLI で使う、NN-only argmax 評価 (= 学習設定の影響を受けない pure benchmark)
 *
 * このファイルが 2 プロファイルの差分の唯一の source of truth。各呼び出し箇所で
 * `'sample'` / `'policy_argmax'` 等のリテラルを直接書かず、必ず `RUN_PROFILES.{training,eval}`
 * を参照すること。リテラルが複数箇所に散ると、self-play-howl と eval ループで設定が
 * 乖離する事故 (実例: 2026-05-13 に self-play-howl の default が `'argmax'` のままになっていて
 * eval と異なる結果が出た) が再発する。
 */

export type RunProfileName = 'training' | 'eval'

export type RunProfile = {
  /** SkollZeroRoleAgent / runMultiAgentSelfPlayGame に渡す selectionMode */
  selectionMode: 'sample' | 'argmax' | 'policy_argmax'
}

export const RUN_PROFILES: Record<RunProfileName, RunProfile> = {
  training: { selectionMode: 'sample' },
  eval: { selectionMode: 'policy_argmax' },
} as const
