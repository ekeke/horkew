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
  /**
   * `${action}:${childPhase}` → child node。
   *
   * 同じ親 + 同じ action でも、stepPhase 後の next phase は world に依存する
   * (advancePhase の skip 判定が world 状態を見るため)。同じ child 表現に纏めると
   * edges の phase 不整合が起きるので、child key に next phase を含めて分岐させる。
   */
  children: Map<string, TreeNode>
  /** 一度でも NN 評価されて edge が初期化されたか */
  expanded: boolean
  /** expand 時の state.phase。children key の `:phase` 部と整合する。 */
  phase?: string
}

export function createTreeNode(): TreeNode {
  return {
    edges: new Map(),
    children: new Map(),
    expanded: false,
  }
}

/** child node の key を組み立てる。`${action}:${childPhase}` */
export function childKey(action: number, childPhase: string): string {
  return `${action}:${childPhase}`
}

/** node の child edges の visits 合計 */
export function totalChildVisits(node: TreeNode): number {
  let total = 0
  for (const edge of node.edges.values()) total += edge.visits
  return total
}
