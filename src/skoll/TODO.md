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

### 霊媒結果による情報更新 [高優先]

処刑後に霊媒（生存・信用時）が黒/白を報告 → ワールドが分岐。

- 各ワールドで処刑者の霊媒結果が確定（`getMediumResult`）
- 結果でワールドをグループ化 → 各グループ内で翌日の勝率を計算
- Hati の `partitionWorldsByExecution` が参考になる

### 猫又の道連れ [中優先]

- 猫又処刑 → ランダム1人道連れ退場（狼を引ければ大きい）
- 猫又噛み → 噛んだ狼が退場
- 処刑候補の猫又確率に応じたリスク/リターン計算

### 占い複数夜モデル [中優先]

現在1夜分の占い結果のみモデル化。占い師が長く生きるほど情報が累積する。再帰的にモデル化すれば精度向上。

### 狼の噛み先モデル改善 [低優先]

現在: 非狼からランダム。実際は占い師・狩人を優先的に狙う。噛み先モデルを「情報価値の高い seat を優先」に変えれば、占い師/狩人の生存価値がより正確に。

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
