# Fenrir 開発メモ (claude.md)

## 学習対象役職

当面の目標では **possessed は学習対象外**。

### 5モデル構成（集団NN採用）

| # | モデル | 種別 | 役職 | 村NN注入 |
|---|--------|------|------|---------|
| 1 | village | 個人 | villager, seer, medium, bodyguard, nekomata | - |
| 2 | wolf_collective | 集団 | werewolf | あり |
| 3 | mason_collective | 集団 | mason | なし |
| 4 | fanatic | 個人 | fanatic | あり |
| 5 | third | 個人 | werehamster, immoralist | - |

- 集団NN: 1つのNNがチーム全員を同時制御（個人NN + チームNNを統合）
- 狂信者は狼と通信不可のため集団に入れない（情報隔壁）
- 狂信者は**専用NN config**（`FANATIC_TRANSFORMER_CONFIG`）: 観測サイズ +168（village_predict 154 + village_trust 14）、Seat 85次元
- `FanaticStrategy extends FenrirStrategy`: infer時にfrozen村NNをforward → `encodeFanaticObservation()` で注入
- 村NN注入: frozen村NNの出力（predict, trust）をper-seat特徴量として注入（狼集団 + 狂信者）
- Phase 1: 村個人 → Phase 1': 狼集団+共有集団+狂信者+第三（frozen村NN注入）→ Phase 2: 自己対戦

### オーケストレーター (`npm run orchestrate`)

Phase 1 → 1' → 2 を自動管理するスクリプト。

- baseline eval で heuristic の陣営別勝率を取得
- Phase 1: 村個人のみ学習 → frozen化 → eval-based graduation
- Phase 1': 狼集団・共有集団・狂信者・第三を学習（frozen村NNを注入）
  - fanatic は `createFanaticNetwork()` / `createFanaticTfNetwork()` で専用NN作成
  - 全5モデル同時評価: `evaluate()` が collective/fanatic strategy を自動構築
  - eval-based graduation（陣営勝率がbaselineを超えたら卒業）
  - Resume対応: `findCheckpoint(dir, prefix)` で collective/individual 両方のcheckpointを検索
- Phase 2: 全モデル自己対戦
- 陣営マッピング: village→villageWin, wolf_collective→wolfWin, fanatic→wolfWin, mason_collective→villageWin, third→hamsterWin
