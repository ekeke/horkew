# Brain Battle — 設計文書

## 動機と背景

### 問題

既存の学習パイプライン (Phase 0 → 1 → 1' → 2) では、村陣営の勝率が 26-41% で停滞している。原因は **adversarial pressure の不足**:

- Phase 0 (Mason Individual): mason が plan token で処刑先を指定するが、対戦相手はヒューリスティック狼。ヒューリスティック狼は固定的な騙りパターンしか持たないため、mason は「弱い敵を倒すだけの浅い戦略」で十分な勝率に到達してしまう
- Phase 1' (Non-Village): wolf_collective/fanatic/third は baseline が低く（15-27%）、即卒業する。学習量が足りない
- mason_collective は壊滅（4-9%）。集団 NN として機能していない

### 着想

人狼ゲームのルールを少し変えて、「共有ブレイン vs 狼ブレイン」が直接対戦する訓練専用モードを作る。個人の投票を排除し、2つのチームブレインが交互に処刑先を決定する。

これにより:
- **mason brain**: 強い敵（NN狼）に対して「誰を吊るべきか」を学ぶ
- **wolf brain**: 「誰を騙るか」「どんな偽結果を出すか」「誰を吊らせるか」「誰を噛むか」を総合的に学ぶ
- **双方向の圧力**: 片方が強くなれば相手も適応を強いられる（自己対戦に近い構造）

### 位置づけ

Phase 1' と Phase 2 の間に配置（Phase BB）。Phase 1' で初期化された wolf/mason の重みを、adversarial 環境で鍛えてから Phase 2 に渡す。ただし重み転送の方法は未確定（まず「ゲームとして成立するか」を確認してから決める）。

---

## ゲームルール

### 基本

- 通常の人狼ゲームルール（14人村、夜フェーズ、CO、終了条件）はそのまま
- **投票をブレインによる一方的決定に置き換え**: 個人プレイヤーの投票は一切なし
- 処刑決定権を持つブレインが、その日の処刑対象を1人選ぶ。全プレイヤーがその対象に投票する（ゲームエンジン上は全員一致投票として処理）

### ターン交代

- **日ごとに交互**: Day 1 は mason、Day 2 は wolf、Day 3 は mason... のように交代
- **先手はランダム**: ゲームごとに seed ベースで mason/wolf をランダムに割り当て
- 先手後手の偏りは大数の法則で平均化する設計

### 役職別の制御

| 役職 | CO/結果 | 投票 | 夜行動 |
|------|---------|------|--------|
| 共有者 | ヒューリスティック（相互CO） | ブレイン決定に従う | なし |
| 占い師 | ヒューリスティック（真結果） | ブレイン決定に従う | ヒューリスティック |
| 霊媒師 | ヒューリスティック（真結果） | ブレイン決定に従う | なし |
| 狩人 | ヒューリスティック | ブレイン決定に従う | ヒューリスティック |
| 猫又 | ヒューリスティック | ブレイン決定に従う | なし |
| 村人 | ヒューリスティック | ブレイン決定に従う | なし |
| **人狼** | **狼ブレインが決定** | ブレイン決定に従う | **狼ブレインが決定** |
| 狂信者 | ヒューリスティック | ブレイン決定に従う | なし |
| 妖狐 | ヒューリスティック | ブレイン決定に従う | なし |
| 背徳者 | ヒューリスティック | ブレイン決定に従う | なし |

### ターン制と処刑のイメージ

```
Day 1: mason ターン → mason brain が plan[0] で処刑先を決定 → 全員がその対象に投票
Day 1 Night: wolf brain が襲撃先を決定、占い師・狩人はヒューリスティック

Day 2: wolf ターン → wolf brain が vote head で処刑先を決定 → 全員がその対象に投票
Day 2 Night: wolf brain が襲撃先を決定

Day 3: mason ターン → ...
(ゲーム終了条件を満たすまで繰り返し)
```

---

## 共有ブレイン（Mason Brain）

### アーキテクチャ

**既存の `MasonCollective` をそのまま使用**。ネットワーク構造の変更なし。

- 入力: mason_collective observation
- 出力: 12-token unified plan（既存の GRU decoder）
- 処刑先: plan の先頭スロットを `planToVote()` で解決

### Mason 死亡後の動作

通常のゲームでは mason 全滅後は cached plan の消費に切り替わるが、Brain Battle では **mason brain が死亡後も推論を継続**する。

- 死亡した mason の seat から observation を構築（公開情報ベース）
- `buildPlayerView()` は死亡プレイヤーでも動作する
- brain は推論を継続し、plan[0] で処刑先を指定

---

## 狼ブレイン（Wolf Brain）

### アーキテクチャ

**新規設計**。入力は wolf_collective と同一だが、出力は完全に異なる。

- 入力: wolf_collective observation (1392 dims)
  - frozen 村 NN 注入は初期実装ではスキップ（168 dims = 0）
- Backbone: Seat Transformer (3層) + Strategy Layer (2層) — 構造は既存と同一
- **GRU decoder なし** (`numPlanTokens: 0`)
- パラメータ数: 177K（GRU なしのためコンパクト）

### 出力ヘッド

全て softmax。12 ヘッド。

#### 騙りフォーメーション（毎日出力、状況に応じて更新）

| Head | Size | Readout | 用途 |
|------|------|---------|------|
| `formation_0` | 6 | CLS | 狼 slot 0 が何を騙るか |
| `formation_1` | 6 | CLS | 狼 slot 1 |
| `formation_2` | 6 | CLS | 狼 slot 2 |

Formation 語彙 (6):

| Index | 意味 | 例 |
|-------|------|-----|
| 0 | 占い騙り (`seer_co`) | 偽占い結果を報告 |
| 1 | 霊能騙り (`medium_co`) | 偽霊能結果を報告 |
| 2 | 狩人騙り (`bodyguard_co`) | 狩人COのみ |
| 3 | 猫又騙り (`nekomata_co`) | 猫又COのみ |
| 4 | 潜伏 (`lurk`) | COしない |
| 5 | 素村CO (`villager_co`) | 素村としてCO |

#### 偽結果

| Head | Size | Readout | 用途 |
|------|------|---------|------|
| `fake_target_0` | 14 | per-seat | 狼 0 の偽結果対象 (占い/霊能で誰を報告するか) |
| `fake_target_1` | 14 | per-seat | 狼 1 |
| `fake_target_2` | 14 | per-seat | 狼 2 |
| `fake_result_0` | 2 | CLS | 狼 0: 白(0) / 黒(1) |
| `fake_result_1` | 2 | CLS | 狼 1 |
| `fake_result_2` | 2 | CLS | 狼 2 |

#### 処刑・襲撃

| Head | Size | Readout | 用途 |
|------|------|---------|------|
| `vote` | 14 | per-seat | 処刑先（狼ターンのみ使用） |
| `attack_target` | 14 | per-seat | 夜の襲撃先 |
| `attacker` | 3 | CLS | どの狼が襲撃実行者か |

### マスキング

| Head | マスク条件 |
|------|-----------|
| `formation_*` | 死亡狼 → 全マスク |
| `fake_target_*` | 死亡席、同チーム除外 |
| `fake_result_*` | 死亡狼 → 全マスク |
| `vote` | 死亡席、狼陣営除外 |
| `attack_target` | 死亡席、狼除外 |
| `attacker` | 死亡狼除外 |

### 推論タイミング

wolf brain は **1日1回** 推論（`CollectiveAgentBase.getOrInfer` による日ベースキャッシュ）。同じ日の CO フェーズ・投票フェーズ・夜フェーズはキャッシュから読む。

---

## 報酬

終端報酬のみ（中間報酬なし）:

| 結果 | Mason Brain | Wolf Brain |
|------|-------------|------------|
| 村勝 | +1.0 | -1.0 |
| 狼勝 | -1.0 | +1.0 |
| 狐勝 | -1.3 | -1.3 |
| 引分 | -0.5 | -0.5 |

---

## 日ごとのゲームフロー

```
1. 夜結果公開（死亡者発表）

2. CO フェーズ (onDayClaims):
   - wolf brain 推論 → formation キャッシュ
   - 各狼: formation に基づいて DayClaim 生成
     - seer_co → fakeDivineHistory に偽結果追加 → seer_result 発火
     - medium_co → 偽霊能結果
     - bodyguard_co / nekomata_co → 単純CO
     - lurk / villager_co → none
   - 非狼: ヒューリスティック（占い師=真結果、霊能=真結果、共有=相互CO）

3. 投票フェーズ (onVote):
   - ターン判定 (mason or wolf)
   - mason ターン: mason brain の plan[0] → planToVote() → target
   - wolf ターン: wolf brain の vote head → target
   - 全生存プレイヤーが target に投票（全員一致）
   - ターン反転

4. 夜フェーズ (onNight):
   - wolf brain: attack_target + attacker → 襲撃
   - 占い師: ヒューリスティック（ランダムグレー対象）
   - 狩人: ヒューリスティック
```

---

## 実装構成

### 新規ファイル

| ファイル | 責務 |
|---------|------|
| `agents/wolf-brain.ts` | WolfBrainAgent: formation/vote/attack の推論 + trajectory 記録 |
| `adapters/brain-battle-adapter.ts` | BrainBattleAdapter: ターン交代、強制投票、CO → formation 変換 |

### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `ml/transformer-network.ts` | `numPlanTokens: 0` で GRU/plan をスキップ |
| `ml/nn-tf-transformer.ts` | 同上（TF.js 側） |
| `training.ts` | `WOLF_BRAIN_TRANSFORMER_CONFIG` + factory |
| `game-worker.ts` | Brain Battle ゲーム生成パス |
| `parallel.ts` | `WorkerRequest` に `brainBattle` + `wolfBrainWeights` |
| `curriculum.ts` | `wolf_brain` NetworkName + Brain Battle TrainingStep |
| `phase-runner.ts` | `runBrainBattlePhase()` |
| `orchestrate.ts` | wolf brain ネットワーク生成 + phase 実行 |
| `agents/team-base.ts` | `CollectiveAgentBase.getOrInfer` を public 化 |

### ネットワーク構成

```
Wolf Brain (177K params):
  Input (1392 dims) → tokenize
    ├── CLS token (24 dims)
    ├── 14 Seat tokens (84 dims each)
    └── 5 Role tokens (15 dims each)
           ↓
    proj → Seat Encoder (3 layers, d=64)
           ↓
    Strategy Encoder (2 layers, 20 tokens — no plan tokens)
           ↓
    ├── CLS → formation(6)×3, fake_result(2)×3, attacker(3)
    └── Seat → vote(14), attack_target(14), fake_target(14)×3
    └── CLS → value(1)

Mason Brain (既存 mason_collective, ~280K params):
  Input → Seat Encoder → Strategy Encoder (32 tokens)
    → GRU Decoder → plan(12×22)
    → value(1)
```

---

## 既知の制限と今後の課題

1. **Mason brain trajectory**: plan token 単位の trajectory 記録が未実装。現状は推論はするが PPO に反映されない。NeuralAgent.recordStrategy() 相当の機能を MasonCollective に追加する必要がある

2. **Frozen 村 NN 注入なし**: wolf brain の観測に含まれる village_predict (154 dims) / village_trust (14 dims) は初期実装ではゼロ。Phase 2 以降で mason brain の出力を注入する拡張が考えられる

3. **偽結果の整合性チェック**: wolf brain の偽結果が Retar 的に矛盾する場合のハンドリングがない。ヒューリスティック狼は `checkRetarConsistency()` で検証するが、wolf brain は raw output をそのまま使う

4. **Formation のスライド制限**: wolf brain は毎日 formation を再決定するが、頻繁なスライド（占い→霊能など）はゲーム的に不自然。将来的にペナルティか制約が必要かもしれない

5. **重み転送パス**: Brain Battle で鍛えた重みを Phase 2 にどう渡すかは未決定
