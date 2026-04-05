# Fenrir 開発メモ (claude.md)

## セッション運用

| コマンド | タイミング | 目的 |
|---------|----------|------|
| `/fenrir-onboard` | セッション開始時 | 基本知識読み込み、学習状況の把握、前セッションの引き継ぎ |
| `/fenrir-handoff` | セッション終了時 | ハンドオフ文書の生成、lessons/memory の更新 |

### ルール

- fenrir の学習に関わる作業を開始するとき、まず `/fenrir-onboard` を実行する
- セッション終了前に `/fenrir-handoff` を実行し、次のセッションが即座に再開できるようにする
- 学習ジョブ実行中のコード変更は次回再起動まで反映されないことに注意
- train-progress.json と eval_log.jsonl が学習状況の正規ソース。memory よりこちらを信頼する

### コミットの break タグ

学習ジョブの再起動が必要な変更にはコミットメッセージの先頭にタグを付ける:

| タグ | 意味 | 必要なアクション |
|------|------|-----------------|
| `[break:all]` | pretrain からやり直し | 新しい checkpoint-base で起動 |
| `[break:ppo]` | PPO のみやり直し | `--resume` で再開（pretrain はスキップ） |
| タグなし | 再起動不要 or 学習に無関係 | そのまま |

確認方法: `bash scripts/check-training-breaks.sh`
起動時の git SHA は `train-status.json` に保存される。

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
- `FanaticAgent extends NeuralAgent`: infer時にfrozen村NNをforward → `encodeFanaticObservation()` で注入
- 村NN注入: frozen村NNの出力（predict, trust）をper-seat特徴量として注入（狼集団 + 狂信者）

## 学習パイプライン

各フェーズの詳細は **[TrainingPhases.md](TrainingPhases.md)** を参照。

```
Pretrain B+D → Phase 0 (Mason Individual) → Phase 1 (Village) → Phase 1' (非村) → Phase 2 (自己対戦)
```

## Strategy-Only モード

`--strategy-only` フラグで有効化。NeuralAgent の意思決定を2層に分離。詳細は **[TrainingPhases.md](TrainingPhases.md)** の Strategy-Only セクションおよび **[ActionAndReward.md](ActionAndReward.md)** を参照。

## Adapter 構成

### クラス階層

```
StrategyBaseAdapter (strategy-base-adapter.ts)
  └── MasonTrainingAdapter (mason-training-adapter.ts)
```

#### StrategyBaseAdapter（抽象基底クラス）

plan ライフサイクルと共通ロジックを管理。onVote はテンプレートメソッドパターン:

1. Retar + Tsumi
2. `beforePlanDistribution()` — hook（サブクラスが planState を更新）
3. `distributePlans()` — planState → ext.executionPlans
4. `collectProposals()` — hook → Proposal[]
5. 投票収集 — 全プレイヤーの decideVote
6. `afterVoteCollection()` — hook

- 全永続データは `state.ext` (`FenrirExt`) 経由で管理
- 通信フェーズ（シグナル・指揮者選出・予告・防御CO）は全スキップ

#### MasonTrainingAdapter（mason 訓練用）

StrategyBaseAdapter を継承し、mason 固有の2つの責務を追加:

1. **Mason が ext.planState を更新できる**（plan 書き込み権限）
2. **村エージェントの投票に plan が 100% 反映される**（executionPlans + Proposal 経由）

- mason takeover: ML mason 死亡時にパートナーへ agent 移譲
- mason 死亡後: cached planState から��毎消費（`advanceDayIndexOnce`）
- endgame 切り替え: ≤6人で endgameGroups を優先

### full-adapter (`adapters/full-adapter.ts`)

**全フェーズ実行**。シグナル 3R、指揮者選出、予告、防御CO、Retar、詰み探索を含む。
非 strategy-only モードおよび eval で使用。StrategyBaseAdapter とは独立（クロージャベース）。

## Seed Bank

事前生成した中盤スナップショットから `resumeGame` でリプレイ。序盤の Retar コストを償却。
`seed-bank.ts` がスナップショット生成・保存・読み込み・ローテーションを担当。

## オーケストレーター

**常に `npm run train:orchestrate` 経由で起動すること**（`TF_FORCE_GPU_ALLOW_GROWTH=true` が設定済み。直接 `node ...` で起動すると GPU VRAM を全取りして OOM になる可能性がある）。

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
  --checkpoint-base tmp/orch-test  # チェックポイント保存先（省略時: 新規=tmp/orch-run-N, resume=前回から自動取得）
  --resume               # 既存チェックポイントから再開
```

### ゲーム生成

- 常に worker pool 経由（直列フォールバックは削除済み）
- `generateGamesParallel()` → game-worker.ts（worker_threads）
- timing 情報は `formatTimingStr()` で統一表示

### 進捗ログ (`train-progress.json`)

`{checkpointBase}/train-progress.json` に JSON で書き出し。eval ごとに更新。
プロジェクトルートの `train-status.json` が現在のラン（runId, pid, checkpointBase, gitSha）の道標。
`train-history.jsonl` がラン履歴（起動・終了）の append-only ログ。

## キーモジュール関係図

```
orchestrate.ts ─── Phase 0/1/1'/2 の学習ループ管理
  ├── parallel.ts ──── worker pool 管理、generateGamesParallel
  │     └── game-worker.ts ──── 1バッチ分のゲーム実行 (worker_threads)
  │           ├── adapters/strategy-base-adapter.ts ── 抽象基底（plan ライフサイクル）
  │           ├── adapters/mason-training-adapter.ts ── mason 訓練用（plan commit + 投票強制）
  │           └── adapters/full-adapter.ts ───── 全フェーズ実行用
  ├── training.ts ──── NN生成、evaluate()、PPO update (ppoUpdate)
  │     ├── ml/transformer-network.ts ─ Seat Transformer (推論用, Pure JS)
  │     └── ml/nn-tf-transformer.ts ─── TF.js GPU 学習用
  ├── agents/ ─────── Agent 実装
  │     ├── agent.ts ──────── Agent/TeamAgent interface, DecisionContext
  │     ├── neural-agent.ts ── NeuralAgent（strategy-only/full 両対応）
  │     ├── rule-based-agent.ts ── RuleBasedAgent（ヒューリスティック）
  │     ├── wolf-collective.ts ── WolfTeamAgent, WolfCollective
  │     ├── mason-collective.ts ─ MasonTeamAgent, MasonCollective
  │     ├── fanatic-agent.ts ──── FanaticAgent
  │     └── team-base.ts ──── TeamAgentBase, CollectiveAgentBase
  ├── plan/ ─────── 処刑プラン管理
  │     ├── plan-vocab.ts ──── PLAN_VOCAB, parsePlanIndices
  │     ├── plan-resolve.ts ── resolvePlanGroup()
  │     └── plan-helpers.ts ── planToVote(), nightAction(), dayClaim() 等
  ├── ext.ts ──────── FenrirExt 型定義, createFenrirExt()
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
