/**
 * AlphaZero スタイルの MCTS ツリーノードと edge 統計。
 *
 * - Node = mason の意思決定地点（vote 直前）
 * - Edge = 1 つの mason action（vote 先 seat）
 * - children[a] = action a を取った後の child node
 *
 * Map ベースで実装（action は seat 番号で疎、numeric array より扱いやすい）。
 * 性能ボトルネックになったら Float32Array へ変更検討。
 */

export type TreeEdge = {
  /** 訪問回数 N(s, a) */
  visits: number
  /** 累積価値 W(s, a) — backup された value の総和 */
  totalValue: number
  /** NN policy prior P(s, a) */
  prior: number
}

export type TreeNode = {
  /** action (vote 先 seat) → edge stats */
  edges: Map<number, TreeEdge>
  /** action → child node */
  children: Map<number, TreeNode>
  /** 一度でも NN 評価されて edge が初期化されたか */
  expanded: boolean
}

export function createTreeNode(): TreeNode {
  return {
    edges: new Map(),
    children: new Map(),
    expanded: false,
  }
}

/** node の child edges の visits 合計 */
export function totalChildVisits(node: TreeNode): number {
  let total = 0
  for (const edge of node.edges.values()) total += edge.visits
  return total
}
