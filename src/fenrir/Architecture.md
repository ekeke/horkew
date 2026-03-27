# Fenrir アーキテクチャ概観

## 全体構成

```
                  ┌─────────────────────────────────┐
                  │          Training Loop           │
                  │  (PPO, TF.js GPU backward)       │
                  └────────────┬────────────────────┘
                               │ 重み同期
                  ┌────────────▼────────────────────┐
                  │      Pure JS NeuralNetwork       │
                  │  (ゲーム内推論、worker_threads)    │
                  └────────────┬────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        Individual       WolfTeam         MasonTeam
         Network          Network           Network
```

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

## 観測ベクトル (OBSERVATION_SIZE = 790)

```
セクション              サイズ   内容
─────────────────────────────────────────────────────────
Global                    17   day, phase, alive_ratio, my_role(11), commander, progress, demand_wolf_co_count
Per-Seat (×14)           350   alive, claimed_role(12), is_me, black/white_count,
                               vote_received, suspicion, trust, execute_proposal,
                               is_commander, accuse_wolf/fox, vote_intent, nominate_commander
Private                   43   divine_results(14), wolf_teammates(14), mason_partner(1),
                               guard_history(14), known_hamster(1)
Revote                    15   revote_round(1), revote_candidates(14)
History (3日分)          210   per day: voted_for, executed, killed, claimed, signaled (×14×5)
Retar Possibilities      154   per-seat × 11 roles (0/1)
─────────────────────────────────────────────────────────
合計                     790
```

チーム追加 (TEAM_OBSERVATION_SIZE = 833):
- team_size: 1
- per-seat: is_my_team + is_current_actor (×14 = 28)
- team_private: fake_divine_results (14)

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
encodeObservation()     ← 790次元 Float32Array
  │
  ▼
NeuralNetwork.forward() ← Pure JS (2.58ms/call)
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

## ファイル構成

```
src/fenrir/
├── src/
│   ├── cli.ts              CLI エントリポイント
│   ├── training.ts         PPO 学習ループ
│   ├── policy.ts           FenrirStrategy / WolfTeam / MasonTeam
│   ├── observation.ts      観測エンコーダ (790 / 833次元)
│   ├── action.ts           アクションマスク・デコード
│   ├── reward.ts           報酬関数
│   ├── evaluate.ts         評価スクリプト
│   ├── play.ts             ゲーム再生 (Howl出力)
│   ├── bench.ts            ベンチマーク
│   ├── parallel.ts         SharedWeights + ワーカープール管理
│   ├── game-worker.ts      ゲーム生成ワーカースレッド
│   └── ml/
│       ├── nn.ts           Pure JS NeuralNetwork (推論用)
│       ├── nn-tf.ts        TF.js GPU NeuralNetwork (学習用)
│       ├── trajectory.ts   GAE + トラジェクトリ処理
│       ├── checkpoint.ts   チェックポイント保存/読込
│       └── optimizer.ts    Adam optimizer
├── Performance.md          ベンチマーク記録
├── Architecture.md         本ドキュメント
└── package.json
```
