/**
 * Huginn 専用カリキュラムのオーケストレーション.
 *
 * orchestrate.ts が `--curriculum huginn` で呼び出すと、既存の fenrir phase ループ
 * (village/wolf/mason 等の PPO 学習) には入らず、このモジュールが
 * 独立して huginn の transformer を scenario ベースで学習する.
 *
 * 入出力:
 *   - 入力: scenarios (カンマ区切り), iterations, gamesPerIter, ハイパーパラメータ
 *   - 出力: `{checkpointBase}/phases/00-huginn/ckpt-huginn/{iter*.json, final.json}`
 *           `{checkpointBase}/phases/00-huginn/phase.done`
 *           `{checkpointBase}/train-progress.json` の `latest` / `evals` を更新
 *
 * 設計:
 *   - fenrir モデル (village/wolf/mason/...) とは完全独立. curriculum.ts の
 *     TrainingStep 型は介さず、huginn 固有の 1 phase 構造として直接書き出す.
 *   - import 境界: src/huginn/ から src/fenrir/ への import は禁止だが、
 *     逆方向 (ここ) から src/huginn/ を参照するのは許可.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { train, type TrainConfig, type IterationLog } from '../../huginn/train.ts'
import { catalog, type Scenario } from '../../huginn/scenarios.ts'

export type HuginnOrchestratorConfig = {
  checkpointBase: string
  /** catalog key の配列. 複数指定は mix 訓練. 空配列でエラー. */
  scenarios: string[]
  iterations: number
  gamesPerIter: number
  lr: number
  dModel?: number
  numLayers?: number
  numHeads?: number
  dFf?: number
  seed?: number
  greedyEvalEvery?: number
  greedyEvalGames?: number
  entropyBonus?: number
  normalizeAdvantage?: boolean
  /** N iter ごとに intermediate checkpoint を書く. 0/未指定なら書かない. */
  checkpointInterval?: number
  /** 最小 iter で全パイプを通すための skeleton フラグ (orchestrate.ts --skeleton 対応). */
  skeleton?: boolean
  /** iter ごとに呼ばれる hook. 主にテスト用. */
  onIteration?: (entry: IterationLog) => void
  /** 標準出力ログを差し替える (default: console.log). テスト用. */
  log?: (line: string) => void
  /** scenario 別 checkpoint subdir 名. 未指定なら `ckpt-huginn/`, 指定時は `ckpt-huginn-{label}/`.
   *  auto-all モード (runHuginnCatalogAll) が scenario ごとに使う. */
  checkpointLabel?: string
  /** phase.done マーカーを書くかどうか (default: true).
   *  auto-all モードは各 scenario 呼び出しで false、最後に外部でまとめて書く. */
  markPhaseDone?: boolean
}

const HUGINN_PHASE_DIR_NAME = '00-huginn'
const HUGINN_MODEL_NAME = 'huginn'

export function huginnPhaseDir(checkpointBase: string): string {
  return join(checkpointBase, 'phases', HUGINN_PHASE_DIR_NAME)
}

export function huginnCheckpointDir(checkpointBase: string, label?: string): string {
  const subdir = label ? `ckpt-${HUGINN_MODEL_NAME}-${label}` : `ckpt-${HUGINN_MODEL_NAME}`
  return join(huginnPhaseDir(checkpointBase), subdir)
}

export function huginnPhaseDoneFile(checkpointBase: string): string {
  return join(huginnPhaseDir(checkpointBase), 'phase.done')
}

/** `--skeleton` 時の強制最小値 (orchestrate.ts と同じ哲学: 全パイプが動くかの確認用). */
const SKELETON_ITERATIONS = 2
const SKELETON_GAMES_PER_ITER = 2

export function runHuginnCurriculum(config: HuginnOrchestratorConfig): {
  history: IterationLog[]
  checkpointDir: string
} {
  if (!config.scenarios || config.scenarios.length === 0) {
    throw new Error('runHuginnCurriculum: --huginn-scenario required (comma-separated scenario names from catalog)')
  }

  const scenarios: Scenario[] = []
  for (const name of config.scenarios) {
    const builder = catalog[name]
    if (!builder) {
      throw new Error(
        `runHuginnCurriculum: unknown scenario "${name}". Available: ${Object.keys(catalog).join(', ')}`,
      )
    }
    scenarios.push(builder())
  }

  const envConfigs = scenarios.map(s => s.envConfig)
  const mixNames = scenarios.map(s => s.name)
  const n0 = envConfigs[0].numAgents
  for (const ec of envConfigs) {
    if (ec.numAgents !== n0) {
      throw new Error(
        `runHuginnCurriculum: mixed scenarios must share numAgents (got ${envConfigs.map(e => e.numAgents).join(', ')})`,
      )
    }
  }

  const checkpointDir = huginnCheckpointDir(config.checkpointBase, config.checkpointLabel)
  mkdirSync(checkpointDir, { recursive: true })

  const skeleton = !!config.skeleton
  const iterations = skeleton ? SKELETON_ITERATIONS : config.iterations
  const gamesPerIter = skeleton ? SKELETON_GAMES_PER_ITER : config.gamesPerIter
  const log = config.log ?? ((line: string) => console.log(line))

  const progressCallback = (entry: IterationLog): void => {
    updateProgressJson(config.checkpointBase, entry, iterations, mixNames)
    if (config.onIteration) config.onIteration(entry)
  }

  const trainConfig: TrainConfig = {
    iterations,
    gamesPerIter,
    lr: config.lr,
    dModel: config.dModel,
    numLayers: config.numLayers,
    numHeads: config.numHeads,
    dFf: config.dFf,
    envConfigs,
    mixNames,
    seed: config.seed ?? 42,
    greedyEvalEvery: config.greedyEvalEvery ?? 0,
    greedyEvalGames: config.greedyEvalGames ?? 32,
    normalizeAdvantage: config.normalizeAdvantage ?? true,
    entropyBonus: config.entropyBonus ?? 0.01,
    checkpointDir,
    checkpointInterval: config.checkpointInterval ?? 0,
    onIteration: (entry) => progressCallback(entry),
    log,
  }

  const { history } = train(trainConfig)

  if (config.markPhaseDone !== false) {
    writeFileSync(huginnPhaseDoneFile(config.checkpointBase), new Date().toISOString())
  }
  return { history, checkpointDir }
}

// ============================================================
// auto-all: catalog の全 scenario を順次個別学習
// ============================================================

export type HuginnCatalogAllConfig = Omit<HuginnOrchestratorConfig, 'scenarios' | 'checkpointLabel' | 'markPhaseDone'>

export function runHuginnCatalogAll(config: HuginnCatalogAllConfig): {
  perScenario: Array<{ scenario: string; history: IterationLog[]; checkpointDir: string }>
} {
  const scenarioNames = Object.keys(catalog)
  if (scenarioNames.length === 0) {
    throw new Error('runHuginnCatalogAll: catalog is empty')
  }

  const log = config.log ?? ((line: string) => console.log(line))
  const perScenario: Array<{ scenario: string; history: IterationLog[]; checkpointDir: string }> = []

  for (let i = 0; i < scenarioNames.length; i++) {
    const name = scenarioNames[i]
    log(`\n[huginn-all] (${i + 1}/${scenarioNames.length}) scenario=${name}`)
    const result = runHuginnCurriculum({
      ...config,
      scenarios: [name],
      checkpointLabel: name,
      markPhaseDone: false,
      log,
    })
    perScenario.push({ scenario: name, history: result.history, checkpointDir: result.checkpointDir })
  }

  writeFileSync(huginnPhaseDoneFile(config.checkpointBase), new Date().toISOString())
  log(`\n[huginn-all] complete. ${scenarioNames.length} scenarios trained.`)
  return { perScenario }
}

// ============================================================
// train-progress.json 更新
// ============================================================

type ProgressEvalEntry = {
  phase: string
  iter: number
  meanReward: number
  greedyMeanReward?: number
  updated: string
}

type ProgressLatest = {
  phase: string
  model: string
  iter: number
  maxIter: number
  meanReward: number
  greedyMeanReward?: number
  updated: string
}

function updateProgressJson(
  checkpointBase: string,
  entry: IterationLog,
  maxIter: number,
  mixNames: string[],
): void {
  const path = join(checkpointBase, 'train-progress.json')
  let progress: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      if (parsed && typeof parsed === 'object') progress = parsed as Record<string, unknown>
    } catch {
      progress = {}
    }
  }
  const latest: ProgressLatest = {
    phase: 'huginn',
    model: mixNames.join('+'),
    iter: entry.iter,
    maxIter,
    meanReward: entry.meanReward,
    updated: new Date().toISOString(),
  }
  if (entry.greedyMeanReward !== undefined) latest.greedyMeanReward = entry.greedyMeanReward
  progress.latest = latest

  if (entry.greedyMeanReward !== undefined) {
    const evals = Array.isArray(progress.evals) ? (progress.evals as ProgressEvalEntry[]) : []
    evals.push({
      phase: 'huginn',
      iter: entry.iter,
      meanReward: entry.meanReward,
      greedyMeanReward: entry.greedyMeanReward,
      updated: new Date().toISOString(),
    })
    progress.evals = evals
  }

  writeFileSync(path, JSON.stringify(progress, null, 2))
}
