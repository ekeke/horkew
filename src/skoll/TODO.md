# Skoll TODO

## 概要

Retar の制約知識を戦略的特徴量に変換するモジュール。
Hati が「詰みがあるか」（二値）を答えるのに対し、Skoll は「最善手と勝率」（連続値）を答える。

## 完了

- [x] Step 1: 確率分布 — Retar の binary possibilities を全ワールド均等重みの role 確率に変換 (`computeRoleProbabilities`)
- [x] Step 2: CO構造ベース解析的勝率 — 占いCOから世界分岐を構築し、吊り候補別の村勝率を計算 (`analyzeExecutions`)
  - `winrate.ts`: 再帰的勝率計算（grays/wolves/confirmed/alive の4整数、メモ化）
  - `branches.ts`: 占いCO分析、共有CO認識、座席分類
  - `analysis.ts`: 分岐 × 吊り候補の勝率統合

## 次のステップ

### Step 2b: 霊媒CO分岐

霊媒COも占いと同様に分岐を構築する。霊能ローラーの価値を定量化できるようになる。

- 霊媒の結果は処刑者の種族（人間/人狼）
- 占い分岐と霊媒分岐の直積で全分岐を生成

### Step 2c: 分岐重み付け

現在は均等重み (1/N)。Retar の確率分布 (Step 1) を使って「seat X が真占いである確率」で重み付けすればより正確に。

### Step 3: 狐 (werehamster) 対応

狐生存時の勝利条件が変わる（村全滅でも狐勝ち）。勝率計算に第三勢力を導入。

### Step 4: Fenrir 統合

- `analyzeExecutions` の結果を Fenrir の observation に追加
- 吊り候補別勝率 (14次元) + 全体勝率 (1次元)
- reward shaping や heuristic の参考値として利用

## 夜モデル（v1）

- 狼は confirmed village を優先的に噛む
- confirmed がいなければ gray の非狼を噛む
- 護衛・占い将来結果は考慮しない

## 未決事項

- 護衛のモデリング（護衛成功で夜死亡なし）
- 占いの将来情報（真占い生存 = 翌日追加情報）
- 夜モデルの改善（最悪ケース vs 平均ケース）
