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

## 学習パイプライン

各フェーズの詳細は **[TrainingPhases.md](TrainingPhases.md)** を参照。

```
Pretrain B+D → Phase 0 (Mason Individual) → Phase 1 (Village) → Phase 1' (非村) → Phase 2 (自己対戦)
```

## Strategy-Only モード

`--strategy-only` フラグで有効化。FenrirStrategy の意思決定を2層に分離。詳細は **[TrainingPhases.md](TrainingPhases.md)** の Strategy-Only セクションおよび **[ActionAndReward.md](ActionAndReward.md)** を参照。

## Adapter 構成

### minimal-adapter (`lupaAdapters/minimal-adapter.ts`)

**strategy-only 訓練用**。通信フェーズ（シグナル・指揮者選出・予告・防御CO）を全スキップ。

- onNight + onDayClaims + onVote のみ実装
- **mason plan 注入**: onVote 内で mason 席の `decideProposal` → `executionPlans` に自動注入
- **mason 死亡後**: plan グループキャッシュから日毎インクリメント（`cachedPlanGroups` + `cachedPlanGroupIndex`）
- **plan 解決**: `resolvePlanGroupSimple()` で seat/grayran を生存席に解決

### full-adapter (`lupaAdapters/full-adapter.ts`)

**全フェーズ実行**。シグナル 3R、指揮者選出、予告、防御CO、Retar、詰み探索を含む。
非 strategy-only モードおよび eval で使用。

## Seed Bank

事前生成した中盤スナップショットから `resumeGame` でリプレイ。序盤の Retar コストを償却。

| ファイル | 役割 |
|----------|------|
| `seed-bank.ts` | スナップショット生成・保存・読み込み・ローテーション |
| `generate-snapshots.ts` | CLI (`npm run generate-snapshots`) |

```
tmp/snapshots/day{1,2,3}/village-3/      — 学習用（ローテーション可）
tmp/snapshots-eval/day{1,2,3}/village-3/  — eval用（固定、Rng(42)で選択）
```

## オーケストレーター (`npm run orchestrate`)

### 主要オプション

```bash
npm run train:orchestrate -- \
  --transformer          # Transformer アーキテクチャ
  --strategy-only        # plan token のみ RL
  --workers 4            # ゲーム生成ワーカー数（デフォルト: auto=CPU-1）
  --iterations 50000     # モデルあたり最大 iter
  --batch 64             # バッチサイズ
  --mini-batch 512       # PPO ミニバッチ
  --eval-interval 100    # eval 間隔
  --checkpoint-base tmp/orch-test  # チェックポイント保存先
  --resume               # 既存チェックポイントから再開
```

### ゲーム生成

- 常に worker pool 経由（直列フォールバックは削除済み）
- `generateGamesParallel()` → game-worker.ts（worker_threads）
- timing 情報は `formatTimingStr()` で統一表示

### 進捗ログ (`progress.md`)

`{checkpointBase}/progress.md` に自動書き出し。eval ごとに上書き更新。

## キーモジュール関係図

```
orchestrate.ts ─── Phase 0/1/1'/2 の学習ループ管理
  ├── parallel.ts ──── worker pool 管理、generateGamesParallel
  │     └── game-worker.ts ──── 1バッチ分のゲーム実行 (worker_threads)
  │           ├── minimal-adapter.ts ── strategy-only用（mason plan注入含む）
  │           └── full-adapter.ts ───── 全フェーズ実行用
  ├── training.ts ──── NN生成、evaluate()、PPO update (ppoUpdate)
  │     ├── ml/transformer-network.ts ─ Seat Transformer (推論用, Pure JS)
  │     └── ml/nn-tf-transformer.ts ─── TF.js GPU 学習用
  ├── policy.ts ─────── FenrirStrategy（strategy-only/full 両対応）
  │     └── rule-action.ts ──── plan token → ゲーム行動変換
  ├── observation.ts ── 盤面 → NN入力エンコード（tokenize含む）
  ├── reward.ts ─────── 報酬設計（terminal, intermediate, predict accuracy）
  └── seed-bank.ts ──── スナップショット生成・読み込み
```

## NN アーキテクチャ (Seat Transformer)

```
Input (1209 dims) → tokenize
  ├── CLS token (26 dims) ─┐
  ├── 14 Seat tokens (73 dims each) ─┤→ proj → Seat Encoder (3 layers, dModel=64)
  └── 5 Role tokens (15 dims each) ──┘          ↓
                                    ┌── 8 Forward plan embeddings ─┐
                                    ├── 4 Endgame plan embeddings ─┤→ Strategy Encoder (2 layers)
                                    └── 20 Seat Encoder outputs ───┘          ↓
                                                                    Action Heads (vote, comm, night, ...)
                                                                    Value Head (scalar)
                                                                    Pointer Mechanism (plan tokens)
```

### 重み命名規則

| プレフィックス | コンポーネント |
|---------------|---------------|
| `proj_cls_*`, `proj_seat_*`, `proj_role_*` | 入力射影 |
| `seat_*` | Seat Transformer Encoder |
| `strat_*` | Strategy Layer Encoder |
| `forward_embeddings`, `endgame_embeddings` | Plan token 学習可能埋め込み |
| `pointer_query_*`, `pointer_key_*`, `special_keys` | Pointer mechanism |
| `head_{name}_*` | Action heads |
| `value_*` | Value head |

`cloneWeights()` / `loadWeights()` で部分転送可能（prefix-based filtering）。
