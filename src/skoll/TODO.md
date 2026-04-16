# Skoll TODO

## 完了

- [x] Step 1: 確率分布 — Retar の binary possibilities を全ワールド均等重みの role 確率に変換 (`computeRoleProbabilities`)

## 次のステップ

### Step 2: 吊り別ワールド分岐

各吊り候補について、処刑後の観測（霊媒結果）でワールドを分岐させる。

- 入力: `Possibilities` + `setup` + 生存者
- 処理: 各 seat を処刑 → 霊媒結果（人間/人狼）でワールドを分割
- 出力: `{ seat, mediumResult, worlds[], alive }[]` の構造
- Hati の `simulate.ts` にある霊媒結果計算・猫又道連れを流用

### Step 3: 夜フェーズのシミュレーション

処刑後の夜を通過させ、翌日の盤面を得る。

- 狼の噛み先: 全パターン列挙 or 最悪ケース（Hati 方式）or 均等ランダム
- 占い結果・狩人護衛の分岐
- 死亡・生存の更新
- 狐噛み（不死）、猫又噛み（道連れ）等の特殊処理

### Step 4: 終端評価と勝率バックプロパゲーション

夜通過後の盤面を再帰的に評価し、勝率を算出する。

- 終端条件: 村勝ち / 狼勝ち / 狐勝ち の判定（`checkOutcome`）
- 非終端: 翌日の吊りフェーズへ再帰
- 各分岐の勝率を重み付き平均で集約
- 探索深度の上限（maxDepth）

### Step 5: 公開 API

```
analyzeExecutions(vs, setup, options?) → ExecutionAnalysis
```

出力イメージ:
```typescript
type ExecutionAnalysis = {
  executions: {
    seat: number
    villageWinRate: number
    wolfWinRate: number
    hamsterWinRate: number
  }[]
  // 吊りなし（平和）の場合の勝率も含む？
}
```

## 未決事項

- **狼の行動モデル**: 最悪ケース（minimax）vs 均等ランダム vs 設定可能
- **占い・狩人の行動**: 村側の最善手を仮定？ランダム？
- **探索深度**: 何日先まで見るか。深いほど正確だがワールド数が爆発
- **ワールド数上限**: 大きい村で列挙が爆発する場合の対策（サンプリング？枝刈り？）
- **Fenrir との統合**: 学習の報酬信号やヒューリスティックとして使うか
