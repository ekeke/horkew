# Fenrir アーキテクチャ概観

## 全体構成

```
                  ┌─────────────────────────────────┐
                  │          Training Loop           │
                  │  (PPO, TF.js GPU backward)       │
                  └────────────┬────────────────────┘
                               │ 重み同期
                  ┌────────────▼────────────────────┐
                  │   AnyNetwork (MLP or Transformer) │
                  │  (ゲーム内推論、worker_threads)    │
                  └────────────┬────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        Individual       WolfTeam         MasonTeam
         Network          Network           Network
```

`NetworkConfig.transformer` の有無でMLPとTransformerを自動切替。
`AnyNetwork` インターフェースにより、学習・推論パイプライン全体で透過的に動作する。

## ネットワーク構成

### Individual Network (全役職共有、624K params)

```
入力: OBSERVATION_SIZE = 790

  ┌─ Trunk ──────────────────────┐
  │  Dense(790 → 512) + ReLU     │
  │  Dense(512 → 256) + ReLU     │
  └──────────┬───────────────────┘
             │
  ┌──────────▼───────────────────────────────────────────┐
  │  Softmax Heads                                       │
  │    night:   15  (14 seats + none) ─── 夜行動先        │
  │    claim:   10  ─── CO種別                            │
  │    vote:    14  ─── 投票先                            │
  │    comm:   119  ─── シグナル (8種×14席 + 7宣言)       │
  │    leader:   3  ─── 指揮者応答 (follow/defy/none)     │
  │    target:  14  ─── 対象選択 (占い先、護衛先等)       │
  │                                                      │
  │  Sigmoid Heads                                       │
  │    propose: 14  ─── 処刑提案 (複数同時選択)           │
  │    predict: 154 ─── 配役予想 (14席×11役職)            │
  │                                                      │
  │  Value Head                                          │
  │    value:    1  (tanh) ─── 状態価値                   │
  └──────────────────────────────────────────────────────┘
```

### Wolf Team Network (647K params)

個人ネットワークと同構造 + 襲撃用ヘッド。入力はチーム拡張観測。

```
入力: TEAM_OBSERVATION_SIZE = 833
      (= 790 + 1 team_size + 14×2 team_flags + 14 fake_divine)

追加ヘッド:
  attack_target: 14  ─── 襲撃先
  attacker:       3  ─── 襲撃者選択 (チーム内index)
```

### Mason Team Network (642K params)

Wolf Team と同構造だが attack_target / attacker ヘッドなし。

## 観測ベクトル (OBSERVATION_SIZE = 984)

```
セクション                サイズ   内容
─────────────────────────────────────────────────────────
Global                      19   day, phase, alive_ratio, my_role(11), commander,
                                 progress, demand_wolf_co, rope_margin, alive_parity
Per-Seat (×14)             350   alive, claimed_role(12), is_me, black/white_count,
                                 vote_received, suspicion, trust, execute_proposal,
                                 is_commander, accuse_wolf/fox, vote_intent, nominate_commander
Private                     44   divine_results(14), wolf_teammates(14), mason_partner(1),
                                 guard_history(14), known_hamster(1)
Revote                      15   revote_round(1), revote_candidates(14)
History (3日分)            210   per day: voted_for, executed, killed, claimed, signaled (×14×5)
Retar Possibilities        154   per-seat × 11 roles (0/1)
Execution Plan (primary)    31   plan_included(14), plan_position(14), plan_global(3)
Plan Tokens                161   plan_token_count(1) + 最大8プラン × 20次元
─────────────────────────────────────────────────────────
合計                       984
```

各プラントークン (20次元): target_mask[14] + type_onehot[5] + priority[1]
プラン種別: roller / decision / designated / grayran / endgame

チーム追加 (TEAM_OBSERVATION_SIZE = 984 + 43 = 1027):
- team_size: 1
- per-seat: is_my_team + is_current_actor (×14 = 28)
- team_private: fake_divine_results (14)

## Transformer Encoder アーキテクチャ (新)

MLP trunk の代替として、Transformer Encoder を使用する。
`NetworkConfig.transformer` フィールドが存在する場合に有効化。

### トークン構成

```
入力: OBSERVATION_SIZE = 984 (フラットFloat32Array)
        │
        ▼
    tokenize()  ─── フラットベクトルをトークン列に分解
        │
        ├─ CLS   (1トークン, 25次元)  ── global + private(非per-seat) + plan_global
        ├─ Seat   (14トークン, 57次元) ── per-seat + history + retar + plan + private
        └─ Plan   (0-8トークン, 20次元) ── 各処刑プラン (可変長)
```

チーム版: CLS=26次元, Seat=60次元 (+is_my_team, is_current_actor, fake_divine)

### エンコーダ

```
                    ┌───────────────────────────────────┐
[CLS, S1..S14, P0..PN] ─→ Input Projection (per-type)   │
                    │     CLS:  Dense(25 → 128)          │
                    │     Seat: Dense(57 → 128)  ×14     │
                    │     Plan: Dense(20 → 128)  ×N      │
                    └────────────┬──────────────────────┘
                                 │
                    ┌────────────▼──────────────────────┐
                    │  TransformerEncoder (3 layers)      │
                    │                                    │
                    │  Per layer (Pre-LN):               │
                    │    x = x + MHA(LN(x))              │
                    │    x = x + FFN(LN(x))              │
                    │                                    │
                    │  d_model=128, heads=4, d_ff=256    │
                    └────────────┬──────────────────────┘
                                 │ Final LayerNorm
                    ┌────────────▼──────────────────────┐
                    │  Head Readout                      │
                    │                                    │
                    │  CLS出力 → global heads:           │
                    │    comm(119), claim(10), leader(3)  │
                    │    value(1, tanh)                   │
                    │                                    │
                    │  Seat出力 → per-seat heads:        │
                    │    vote(14), target(14)  ── 1logit/seat │
                    │    propose(14)           ── sigmoid │
                    │    predict(154=14×11)    ── sigmoid │
                    │    night(15) ── 14 seat + 1 CLS    │
                    └────────────────────────────────────┘
```

### パラメータ・性能

| 項目 | MLP | Transformer |
|------|-----|-------------|
| パラメータ数 | ~560K | ~430K |
| 推論 (pure JS) | ~1-2ms | ~15ms |
| 学習 | TfNeuralNetwork | TfTransformerNetwork |
| 推論 | NeuralNetwork | TransformerNetwork |

### 使い方

`--transformer` フラグでMLP/Transformerを切り替える。未指定時はMLP。

```bash
# MLP (従来通り)
npm run train

# Transformer
npm run train -- --transformer

# Transformer + 並列ワーカー + Retar無効化
npm run train -- --transformer --workers auto --no-retar

# Transformerスモークテスト (短時間)
npm run train -- --transformer --iterations 10 --batch 4 --eval-interval 5 --no-retar

# チェックポイントから再開
npm run train -- --transformer --resume

# オーケストレーター (6モデル Phase 1 → Phase 2)
npm run train:orchestrate -- --transformer --workers 3
```

`--transformer` は以下のコマンドすべてで利用可能:
- `npm run train` (cli.ts) — 単一モデル学習
- `npm run train:orchestrate` (orchestrate.ts) — 6モデル ラウンドロビン学習
  - Phase 2 の子プロセスにも自動で引き継がれる

```typescript
// コード例: Transformer ネットワーク構築 (プログラムから)
import { createTransformerNetwork, createTransformerTfNetwork } from './training.ts'

// 推論用 (pure JS, game-worker内)
const net = createTransformerNetwork()
const result = net.forward(observation)  // ForwardResult (MLPと同一)

// 学習用 (tf.js GPU)
const tfNet = createTransformerTfNetwork(lr)
tfNet.trainBatch({ observations, actionHeads, ... })  // PPO
tfNet.trainSupervisedVote({ observations, labels, masks })  // 教師あり
```

### 処刑プラン (ExecutionPlan)

```typescript
type PlanType = 'roller' | 'decision' | 'designated' | 'grayran' | 'endgame'

type ExecutionPlan = {
  targets: number[]   // 処刑対象 or endgameの候補集合
  type: PlanType
}

// DecisionContext
executionPlans: ExecutionPlan[]  // 空配列 = プランなし、複数可
```

- 各プランはTransformerの独立したトークンとして入力
- Attentionが席トークンとプラントークンの関係を自然に学習
- endgame: targets に候補を入れ、type='endgame' で「この中から1人」を表現

### ファイル構成 (Transformer関連)

```
src/fenrir/src/ml/
├── transformer.ts           Transformer基本ブロック (LayerNorm, MHA, FFN)
├── transformer-network.ts   TransformerNetwork (pure JS推論)
├── nn-tf-transformer.ts     TfTransformerNetwork (tf.js GPU学習)
├── nn.ts                    NetworkConfig, AnyNetwork interface
└── transformer.test.ts      テスト (16ケース)
```

## アクション空間・報酬設計

→ [ActionAndReward.md](ActionAndReward.md) に分離（ドメイン設計ドキュメント）

## 学習アルゴリズム

### PPO (Proximal Policy Optimization)

```
1. ゲーム生成 (worker_threads 並列)
   └─ Pure JS NN で推論、trajectory 収集

2. GAE (Generalized Advantage Estimation)
   └─ γ=0.99, λ=0.95

3. PPO 更新 (TF.js GPU、4 epochs)
   ├─ Policy loss: min(ratio × A, clip(ratio, 1±ε) × A)
   ├─ Value loss: MSE(V, return) × 0.5
   └─ Entropy bonus: H(π) × 0.01

4. 重み同期: TF.js → Pure JS NN
```

### カリキュラム学習 (3 Phase)

```
Phase 1 (0 ~ phase1End):     vs Heuristic
  └─ --ml-roles で学習対象役職を限定可能
  └─ 未指定seatは defaultStrategy (HeuristicStrategy) にフォールバック

Phase 2 (phase1End ~ phase2End):  Self-play
  └─ 全seatがML、チーム戦略もML

Phase 3 (phase2End ~):        Pool-based self-play
  └─ 過去5チェックポイントからランダムに対戦相手を選出
```

## 推論パイプライン

```
DecisionContext
  │
  ▼
encodeObservation()     ← 984次元 Float32Array
  │
  ├─ MLP:        NeuralNetwork.forward()         ← ~1-2ms/call
  └─ Transformer: TransformerNetwork.forward()    ← ~15ms/call
       (内部で tokenize() → Encoder → Head Readout)
  │
  ▼
ForwardResult { policies: Map<head, Float32Array>, value: number }
  │
  ▼
maskXxx(ctx) + selectAction(logits, mask)  ← 不正行動除外 + サンプリング
  │
  ▼
decodeXxx(actionIdx)    ← NightAction / DayClaim / number(vote) / etc.
```

MLP/Transformer問わず同一のForwardResultを返すため、パイプラインの後段は一切変更不要。

## ファイル構成

```
src/fenrir/
├── src/
│   ├── cli.ts              CLI エントリポイント
│   ├── training.ts         PPO 学習ループ + ネットワークConfig/Factory
│   ├── policy.ts           FenrirStrategy / WolfTeam / MasonTeam (AnyNetwork対応)
│   ├── observation.ts      観測エンコーダ (984次元) + tokenize()
│   ├── action.ts           アクションマスク・デコード
│   ├── reward.ts           報酬関数
│   ├── evaluate.ts         評価スクリプト
│   ├── play.ts             ゲーム再生 (Howl出力)
│   ├── bench.ts            ベンチマーク
│   ├── parallel.ts         SharedWeights + ワーカープール管理 (AnyNetwork対応)
│   ├── game-worker.ts      ゲーム生成ワーカースレッド (自動アーキテクチャ判別)
│   └── ml/
│       ├── nn.ts           NeuralNetwork (MLP推論), AnyNetwork interface, NetworkConfig
│       ├── nn-tf.ts        TfNeuralNetwork (MLP, tf.js GPU学習)
│       ├── transformer.ts          Transformer基本ブロック (LayerNorm, MHA, FFN)
│       ├── transformer-network.ts  TransformerNetwork (pure JS推論)
│       ├── nn-tf-transformer.ts    TfTransformerNetwork (tf.js GPU学習)
│       ├── transformer.test.ts     Transformerテスト (16ケース)
│       ├── execution-plan.ts       処刑プラン分類 + フォーマット
│       ├── execution-plan-data.ts  事前学習用合成データ生成
│       ├── pretrain-plan.ts        処刑プラン事前学習スクリプト
│       ├── trajectory.ts   GAE + トラジェクトリ処理
│       ├── checkpoint.ts   チェックポイント保存/読込
│       └── optimizer.ts    Adam optimizer
├── Performance.md          ベンチマーク記録
├── Architecture.md         本ドキュメント
└── package.json
```
