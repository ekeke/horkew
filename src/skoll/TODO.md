# Skoll TODO

## 概要

Retar の制約知識を戦略的特徴量に変換するモジュール。
Hati が「詰みがあるか」（二値）を答えるのに対し、Skoll は「最善手と勝率」（連続値）を答える。

## 完了

- [x] Step 1: 確率分布 — Retar の binary possibilities を全ワールド均等重みの role 確率に変換 (`computeRoleProbabilities`)
- [x] CO構造ベース解析的勝率 — 占いCOから世界分岐を構築、Retar で重み付け (`analyzeExecutions`)
  - `winrate.ts`: 再帰的勝率計算（grays/wolves/confirmed/alive の4整数、メモ化）
  - `branches.ts`: 占いCO分析、Retar 連携（seer排除で分岐除外、wolf排除で確定村）
  - `analysis.ts`: 分岐 × 吊り候補の勝率統合
  - 限界: wolf/possessed 区別不可、退場済みの狼数が近似、confirmed_wolf の再帰的扱いに問題
- [x] ワールド列挙ベース吊り分析 (`analyzeExecutionsByWorld`)
  - Hati の `enumerateWorlds` + `checkOutcome` + `applyExecution` を再利用
  - 各ワールドで wolf/possessed が確定 → 正確な吊り結果
  - ongoing は `computeWinRate` で近似
- [x] 占い師生存価値 — 占い師が生存しているワールドで翌夜の占い結果を確率的にモデル化
  - P(狼発見) × winRate(wolves-1) + P(白発見) × winRate(confirmed+1)
- [x] 狩人 GJ 価値 — パリティ依存の護衛ブロックモデル
  - 偶数進行（aliveAfterExec 奇数）: GJ で +1 処刑機会 → 正のボーナス
  - 奇数進行（aliveAfterExec 偶数）: 密度希釈のみ → クランプで 0
  - ランダム処刑モデルの限界により偶数 aliveAfterExec では逆効果を示すため非負クランプ
- [x] 狐 (werehamster) 対応 — 狐生存時の勝敗分岐
  - `computeWinRate` に `foxes` 次元を追加（grays, wolves, foxes, confirmed, alive）
  - 終端条件: 狼全退場+狐生存→0 (hamster_win)、PP判定 `2w+f >= alive`
  - `estimateOngoingWinRate` で `world.hamsterMask & alive` から生存狐数を取得
  - `estimateNextDay` で占いの呪殺を P(seer→狐) で確率的にモデル化
  - 未対応: 背徳者後追い（immoralist 数を追跡していない）

## 次のステップ

- [x] 霊媒結果による情報更新 — 処刑後の黒/白報告を勝率に反映
  - `World` 型に `mediumMask` 追加（`worlds.ts` の `createWorld` で populate）
  - `estimateOngoingWinRate` で `world.mediumMask & alive` から霊媒生存を確認
  - `estimateNextDay` の霊媒モデル:
    - 霊媒生存 → `grays -= 1, confirmed += 1`（霊媒席はランダム処刑から除外）
    - 霊媒黒（狼吊り確認）→ さらに `confirmed += 1`（捕捉確認ボーナス）
    - 霊媒白（ハズレ確認）→ 追加なし
  - 効果: 霊媒あり 1/2 vs なし 1/3（5人1狼で村吊り後）など、勝率の精度向上
- [x] 猫又の道連れ — 猫又処刑・噛みの道連れを確率的にモデル化
  - `World` 型に `nekomataMask` 追加（`worlds.ts` の `createWorld` で populate）
  - `analyzeExecutionsByWorld` で猫又処刑を検出: 道連れ候補全席で平均を取る
    - 各道連れ先で `checkOutcome` → `village_win/ongoing/wolf_win` を分岐
    - 道連れ先が狼 → 村勝ちに直結（大きなボーナス）
  - `estimateOngoingWinRate` で猫又噛みモデル:
    - `aliveWolves >= 2`（LW は猫又を噛まない）の場合に適用
    - `pBiteNeko = aliveNekomata / aliveNonWolves` で確率分岐
    - 猫又噛み → `aliveTotal-2, wolves-1`（猫又と噛んだ狼が退場）
  - 限界: 狼が1匹のみ（LW）の場合は猫又噛みなし（既に除外済み）

- [x] 完全ミニマックス勝率計算 (`minimaxWinRate` / `minimaxNightWinRate`)
  - 村（MAX）と狼（MIN）が最善手を指す前提
  - 状態: (wolves, foxes, grays, confirmedVillage, confirmedWolves, seer, medium, bodyguard, nekomata) 26bit
  - 日フェーズ: 確定狼処刑 or グレーランダム処刑の高い方
  - 夜フェーズ: 占い師/霊媒/狩人/猫又/グレー村人/確定白 の各噛み先から狼が最小化
  - 占い師: 夜行動で狼発見(confirmedWolves+1) / 狐呪殺 / 白確定(confirmedVillage+1) の期待値
  - 狩人: ランダム護衛 P=1/(alive-totalWolves) で狼の最善手をブロック
  - `minimaxNightWinRate`: 処刑直後（夜開始）から計算するエントリポイント
  - `estimateOngoingWinRate` が `minimaxNightWinRate` を呼ぶよう更新

### 占い複数夜モデル [完了済み]

完全ミニマックスで実装済み。`mmSeer` が `minimaxWinRate`（日フェーズ）を再帰的に呼ぶため、占い師が複数夜生き残った場合の情報累積も自動的にモデル化される。

### 狼の噛み先モデル改善 [完了済み]

完全ミニマックスで実装済み。狼は村勝率を最小化する噛み先を選択するため、占い師・霊媒・狩人を優先的に狙う動作が自然に出る。

### Fenrir 統合 [将来]

- `analyzeExecutionsByWorld` の結果を Fenrir の observation に追加
- 吊り候補別勝率 (SEATS 次元) + 全体勝率 (1次元)
- reward shaping や heuristic の参考値として利用

## アーキテクチャ

```
src/skoll/
  index.ts              Step 1: 確率分布 (computeRoleProbabilities)
  winrate.ts            再帰的勝率計算 (grays/wolves/foxes/confirmed/alive)
  branches.ts           CO構造分析 + Retar連携座席分類
  analysis.ts           CO分岐ベース吊り分析 (analyzeExecutions)
  world-analysis.ts     ワールド列挙ベース吊り分析 (analyzeExecutionsByWorld) ← メイン
  types.ts              共有型定義
  TODO.md               このファイル
```

`world-analysis.ts` が現在のメインの分析エンジン。`branches.ts` / `analysis.ts` は CO 構造の可視化や Fenrir 向け特徴量として残す可能性あり。

## 既知の制限

- **ランダム処刑仮定**: computeWinRate は全グレーから均等に処刑する前提。実際は情報ベース。このため alive 増加（GJ等）が密度希釈として負の影響を示すケースがある
- **1夜先読みのみ**: 占い・狩人の効果は1夜分のみ。累積効果は未モデル化
- **背徳者未対応**: 狐退場時の背徳者後追いを immoralist 数として追跡していない
