import type { StrategyNode } from './types.ts'

/**
 * 戦略木を日本語テキストに変換する
 */
export function formatStrategy(node: StrategyNode, indent: number = 0): string {
  const pad = '  '.repeat(indent)

  if (node.type === 'win') {
    return `${pad}→ 村勝利\n`
  }

  const lines: string[] = []
  const action = node.action

  if (action.execute !== -1) {
    // 昼: 処刑アクション
    lines.push(`${pad}処刑: ${action.execute}番`)
    if (action.bodyguardTarget !== null) {
      lines.push(`${pad}  護衛: ${action.bodyguardTarget}番`)
    }
    if (action.seerTarget !== null) {
      lines.push(`${pad}  占い: ${action.seerTarget}番`)
    }
  } else {
    // 夜: 護衛・占いのみ
    const nightActions: string[] = []
    if (action.bodyguardTarget !== null) {
      nightActions.push(`護衛→${action.bodyguardTarget}番`)
    }
    if (action.seerTarget !== null) {
      nightActions.push(`占い→${action.seerTarget}番`)
    }
    if (nightActions.length > 0) {
      lines.push(`${pad}夜行動: ${nightActions.join(', ')}`)
    }
  }

  for (const [obsKey, child] of Object.entries(node.branches)) {
    const obsLabel = formatObservationKey(obsKey)
    lines.push(`${pad}  [${obsLabel}]`)
    lines.push(formatStrategy(child, indent + 2))
  }

  return lines.join('\n')
}

function formatObservationKey(key: string): string {
  return key
    .replace(/^m:wolf$/, '●の場合')
    .replace(/^m:human$/, '○の場合')
    .replace(/^peace$/, '平和')
    .replace(/^d:/, '死亡:')
    .replace(/\|s:wolf$/, ' 占い●')
    .replace(/\|s:human$/, ' 占い○')
    .replace(/\|neko:(\d+)/, ' 猫又道連れ:$1番')
    .replace(/\|follow:/, ' 後追い:')
}

/**
 * 詰み結果のサマリーを日本語で出力
 */
export function formatTsumiResult(result: import('./types.ts').TsumiResult): string {
  const lines: string[] = []

  if (result.isTsumi) {
    lines.push('=== 詰み進行あり ===')
    if (result.strategy) {
      lines.push('')
      lines.push(formatStrategy(result.strategy))
    }
  } else {
    lines.push('=== 詰み進行なし ===')
  }

  lines.push('')
  lines.push(`探索ワールド数: ${result.stats.worldsTotal}`)
  lines.push(`探索ノード数: ${result.stats.nodesVisited}`)
  lines.push(`最大深度: ${result.stats.maxDepth}`)
  lines.push(`所要時間: ${result.stats.elapsed.toFixed(1)}ms`)

  return lines.join('\n')
}
