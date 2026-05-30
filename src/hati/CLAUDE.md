# Hati — 詰み探索エンジン

## 最重要: 判定と探索は別API

```
searchTsumi(vs, setup, opts)          → TsumiResult   判定のみ。探索しない。
searchTsumiStrategy(tsumiResult, opts) → strategy      手順構築。ユーザーが明示的に呼ぶ。
```

### 呼び出しパターン

```typescript
// 判定のみ（fenrir training など高速パス）
const result = searchTsumi(vs, setup, analyzeOptions)
if (result.isTsumi) { /* 詰みあり */ }

// 判定 + 手順構築（verify, bench, CLI）
const result = searchTsumi(vs, setup, analyzeOptions)
if (result.isTsumi) {
  const sr = searchTsumiStrategy(result, { maxDepth: 5 })
  // sr.strategy を使う
}
```

### 判定フェーズ (`searchTsumi` → `judgeTsumi`)

- **計算だけで詰みの可否を決定する。**
- 入力: Retarの `Possibilities`（各席の役職可能性ビットマスク）
- 出力: `TsumiResult`（`isTsumi`, `judgment`, `conclusions`, `setup`, `day`）
- ワールド列挙もAND-OR探索も行わない
- `isThreatExceeded` が判定ロジックを担当

### 探索フェーズ (`searchTsumiStrategy`)

- **判定で `isTsumi=true` の場合にユーザーが明示的に呼ぶ**
- `TsumiResult` を丸ごと受け取る（conclusions, setup, day を内包）
- ワールド列挙 → 枝刈り → AND-OR木探索
- `isExecInsufficient`, `simulateFoxElimination` は探索の枝刈り（探索高速化のため）
- これらは判定には使わない

### なぜこうなっているか

Hatiは当初、AND-OR全探索で詰みを判定する設計だった。
途中で「計算だけで判定が出せる」というピボットが起き、
探索は手順構築のためだけに残った。
判定と探索を別APIに分離し、探索が不要な呼び出し元（fenrir等）が
`SearchOptions` に依存しなくて済むようにした。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `index.ts` | 公開API: `searchTsumi`, `judgeTsumi`, `searchTsumiStrategy` |
| `types.ts` | 型定義: `World`, `TsumiJudgment`, `TsumiResult`, `SearchOptions` |
| `role-attributes.ts` | 役職 → 属性ビット の事前計算ルックアップ + helper |
| `search.ts` | AND-OR木探索エンジン |
| `foxResolver.ts` | 狐排除可能性の探索（探索フェーズの枝刈り） |
| `simulate.ts` | 夜フェーズシミュレーション |
| `worlds.ts` | ワールド列挙（探索フェーズ用） |
| `verify.ts` | 正しさ検証スクリプト |
| `bench.ts` | ベンチマーク |

## 属性ベース判定 (役職名を内部参照しない)

Hati のロジックは役職名（`'werewolf'` 等）を直接見ない。役職の能力・陣営は属性 (trait + faction) に展開し、`World` 型の属性別マスク経由で判定する。

- `wolfFactionMask` / `foxFactionMask` — 陣営マスク (勝利判定で使う)
- `attackCapableMask` (action:attack) / `divineCapableMask` (action:divine) / `guardCapableMask` (action:guard)
- `attackImmuneMask` / `dieWhenDivinedMask` — 受動 trait
- `curseOnExecutedMask` / `curseOnKilledMask` / `followFoxDeathMask` — 反応 trait
- `mediumshipMask` — auto-info: execution-species

`Possibilities` / `setup` の役職名キーは [role-attributes.ts](role-attributes.ts) の `possibilityHasAttribute` / `setupCountByAttribute` 等を介して属性問い合わせに置き換える。

新役職を増やしても `systemRoles` に trait を埋めれば Hati 側の変更は不要。
