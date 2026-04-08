/**
 * Win-Rate Estimator 評価指標
 *
 * Brier Score, calibration, per-class accuracy, log loss
 */

import { NUM_CLASSES } from './winrate-network.ts'

export type WinrateMetrics = {
  /** Brier Score: mean(Σ(p_i - y_i)²) — 低いほど良い。3クラス周辺確率ベースラインは ~0.44 */
  brierScore: number
  /** Log loss (cross-entropy) — 低いほど良い */
  logLoss: number
  /** Argmax accuracy — 高いほど良い */
  accuracy: number
  /** Per-class accuracy [village, wolf, fox] */
  perClassAccuracy: number[]
  /** Per-class sample count [village, wolf, fox] */
  perClassCount: number[]
  /** Calibration bins: { predicted, actual, count }[] */
  calibrationBins: CalibrationBin[]
  /** Calibration slope (linear regression of actual vs predicted) */
  calibrationSlope: number
}

export type CalibrationBin = {
  /** Bin中央の予測確率 */
  predicted: number
  /** Bin内の実際の正解率 */
  actual: number
  /** Bin内のサンプル数 */
  count: number
}

/**
 * 勝率予測の評価指標を計算
 * @param predictions [n][3] — モデルの出力確率
 * @param labels [n][3] — one-hot ラベル
 */
export function evaluateWinrate(
  predictions: Float32Array[],
  labels: Float32Array[],
): WinrateMetrics {
  const n = predictions.length
  if (n === 0) throw new Error('No samples to evaluate')

  let brierSum = 0
  let logLossSum = 0
  let correctCount = 0
  const perClassCorrect = [0, 0, 0]
  const perClassTotal = [0, 0, 0]

  // Calibration: 全 (predicted, actual) ペアを収集（勝ちクラスのみ）
  const calibrationPairs: { predicted: number, actual: number }[] = []

  for (let i = 0; i < n; i++) {
    const pred = predictions[i]
    const label = labels[i]

    // Brier Score
    let brier = 0
    for (let c = 0; c < NUM_CLASSES; c++) {
      const diff = pred[c] - label[c]
      brier += diff * diff
    }
    brierSum += brier

    // Log loss
    let ll = 0
    for (let c = 0; c < NUM_CLASSES; c++) {
      if (label[c] > 0) {
        ll -= Math.log(Math.max(pred[c], 1e-7))
      }
    }
    logLossSum += ll

    // Accuracy
    let predArgmax = 0, labelArgmax = 0
    for (let c = 1; c < NUM_CLASSES; c++) {
      if (pred[c] > pred[predArgmax]) predArgmax = c
      if (label[c] > label[labelArgmax]) labelArgmax = c
    }
    if (predArgmax === labelArgmax) correctCount++

    // Per-class
    perClassTotal[labelArgmax]++
    if (predArgmax === labelArgmax) perClassCorrect[labelArgmax]++

    // Calibration: 各クラスについて predicted vs actual ペア
    for (let c = 0; c < NUM_CLASSES; c++) {
      calibrationPairs.push({
        predicted: pred[c],
        actual: label[c],
      })
    }
  }

  // Calibration binning (10 bins)
  const NUM_BINS = 10
  const calibrationBins = computeCalibrationBins(calibrationPairs, NUM_BINS)
  const calibrationSlope = computeCalibrationSlope(calibrationBins)

  return {
    brierScore: brierSum / n,
    logLoss: logLossSum / n,
    accuracy: correctCount / n,
    perClassAccuracy: perClassTotal.map((total, i) => total > 0 ? perClassCorrect[i] / total : 0),
    perClassCount: perClassTotal,
    calibrationBins,
    calibrationSlope,
  }
}

/**
 * Calibration binning
 */
function computeCalibrationBins(
  pairs: { predicted: number, actual: number }[],
  numBins: number,
): CalibrationBin[] {
  const bins: { predSum: number, actualSum: number, count: number }[] = []
  for (let i = 0; i < numBins; i++) {
    bins.push({ predSum: 0, actualSum: 0, count: 0 })
  }

  for (const { predicted, actual } of pairs) {
    const binIdx = Math.min(Math.floor(predicted * numBins), numBins - 1)
    bins[binIdx].predSum += predicted
    bins[binIdx].actualSum += actual
    bins[binIdx].count++
  }

  return bins.map((bin, i) => ({
    predicted: bin.count > 0 ? bin.predSum / bin.count : (i + 0.5) / numBins,
    actual: bin.count > 0 ? bin.actualSum / bin.count : 0,
    count: bin.count,
  }))
}

/**
 * Calibration slope: actual = slope * predicted + intercept
 * 完全較正なら slope ≈ 1.0
 */
function computeCalibrationSlope(bins: CalibrationBin[]): number {
  // Weighted linear regression (weight = count)
  const nonEmpty = bins.filter(b => b.count > 0)
  if (nonEmpty.length < 2) return 1.0

  let sumW = 0, sumWX = 0, sumWY = 0, sumWXX = 0, sumWXY = 0
  for (const bin of nonEmpty) {
    const w = bin.count
    sumW += w
    sumWX += w * bin.predicted
    sumWY += w * bin.actual
    sumWXX += w * bin.predicted * bin.predicted
    sumWXY += w * bin.predicted * bin.actual
  }

  const denom = sumW * sumWXX - sumWX * sumWX
  if (Math.abs(denom) < 1e-10) return 1.0

  return (sumW * sumWXY - sumWX * sumWY) / denom
}

/**
 * ベースライン: 常に周辺確率を出力するモデルのBrier Score
 */
export function marginalBaselineBrierScore(perClassCount: number[]): number {
  const total = perClassCount.reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  const marginal = perClassCount.map(c => c / total)

  // Brier = Σ_c (p_c - y_c)^2, 期待値 = Σ_c [p_c*(1-p_c)^2 + (1-p_c)*p_c^2]
  //       = Σ_c p_c(1-p_c)
  let brier = 0
  for (let c = 0; c < NUM_CLASSES; c++) {
    brier += marginal[c] * (1 - marginal[c]) * (1 - marginal[c])  // 正解クラスの寄与
    // 不正解クラスの寄与
    for (let c2 = 0; c2 < NUM_CLASSES; c2++) {
      if (c2 !== c) {
        brier += marginal[c] * marginal[c2] * marginal[c2]
      }
    }
  }
  // ↑ は展開すると Σ_c [ marginal[c] * Σ_c2 (marginal[c2] - δ(c,c2))^2 ]
  // = Σ_c marginal[c] * [ Σ_c2 marginal[c2]^2 - 2*marginal[c] + 1 ]

  // もっとシンプルに: E[brier] = Σ_c 2*p_c*(1-p_c) ... いや正確に計算し直す
  // Brier = (1/N) Σ_i Σ_c (p_c - y_{i,c})^2
  // 常に marginal を出す場合:
  // = Σ_c [ fraction_c * (marginal_c - 1)^2 + (1 - fraction_c) * marginal_c^2 ]
  // = Σ_c [ fraction_c * (1 - 2*marginal_c + marginal_c^2) + (1-fraction_c) * marginal_c^2 ]
  // = Σ_c [ fraction_c - 2*fraction_c*marginal_c + marginal_c^2 ]
  // fraction_c = marginal_c なので:
  // = Σ_c [ marginal_c - 2*marginal_c^2 + marginal_c^2 ]
  // = Σ_c [ marginal_c - marginal_c^2 ]
  // = Σ_c marginal_c * (1 - marginal_c)

  // ただしこれは1クラス分。全3クラスのBrier Scoreなので:
  // 各サンプルの brier = Σ_c (p_c - y_c)^2 を全サンプルで平均

  // やり直し（シンプルに）
  let baselineBrier = 0
  for (let c = 0; c < NUM_CLASSES; c++) {
    // サンプルがクラスcの場合（確率 marginal[c]）: Σ_c2 (marginal[c2] - δ(c,c2))^2
    let sampleBrier = 0
    for (let c2 = 0; c2 < NUM_CLASSES; c2++) {
      const target = c === c2 ? 1 : 0
      sampleBrier += (marginal[c2] - target) ** 2
    }
    baselineBrier += marginal[c] * sampleBrier
  }

  return baselineBrier
}

/**
 * メトリクスをフォーマットして表示用文字列にする
 */
export function formatWinrateMetrics(metrics: WinrateMetrics, baselineBrier?: number): string {
  const lines: string[] = []
  lines.push(`Brier Score: ${metrics.brierScore.toFixed(4)}${baselineBrier !== undefined ? ` (baseline: ${baselineBrier.toFixed(4)})` : ''}`)
  lines.push(`Log Loss:    ${metrics.logLoss.toFixed(4)}`)
  lines.push(`Accuracy:    ${(metrics.accuracy * 100).toFixed(1)}%`)
  lines.push(`Per-class accuracy:`)
  const classNames = ['village', 'wolf', 'fox']
  for (let c = 0; c < NUM_CLASSES; c++) {
    lines.push(`  ${classNames[c]}: ${(metrics.perClassAccuracy[c] * 100).toFixed(1)}% (n=${metrics.perClassCount[c]})`)
  }
  lines.push(`Calibration slope: ${metrics.calibrationSlope.toFixed(3)} (ideal: 1.0)`)
  lines.push(`Calibration bins:`)
  for (const bin of metrics.calibrationBins) {
    if (bin.count > 0) {
      lines.push(`  [${bin.predicted.toFixed(2)}] pred=${bin.predicted.toFixed(3)} actual=${bin.actual.toFixed(3)} n=${bin.count}`)
    }
  }
  return lines.join('\n')
}
