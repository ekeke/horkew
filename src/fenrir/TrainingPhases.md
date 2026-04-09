# 学習フェーズ詳細

オーケストレーター (`orchestrate.ts`) が管理する学習パイプラインの各フェーズを記述する。

1. **Pretrain B+D** — plan token と行動ヘッドの教師あり初期化
2. **Phase 0: Mason Individual** — 確定白の共有者で盤面読解力を事前学習（Day 4→1 カリキュラム）
3. **Phase 1: Village** — frozen mason の指揮下で村陣営モデルを学習（Day 3→1、seats 1→6）
4. **Phase 1': Non-Village** — frozen 村NN を注入して狼・狂信者・共有集団・第三勢力を学習
5. **Phase 2: Self-Play** — 全5モデルによる自己対戦（未実装）

---

## Pretrain B+D

**目的**: NN の初期重みをランダムから脱出させる。

| ステップ | 内容 | 学習対象ヘッド |
|---------|------|---------------|
| Pretrain B | Plan token の教師あり学習。正解ラベル付き処刑プランをバッチ生成して supervised cross-entropy。統一12トークンシーケンス | plan |
| Pretrain D | ヒューリスティック 100 ゲームの行動データを収集し、vote/claim/comm を教師あり BCE | vote, claim, comm（plan は freeze） |

- Pretrain 後に PPO 学習率を `lr × 0.2` に下げる（pretrain 知識保持）
- checkpoint_0 として保存（起動時プロンプトで `p` を選択すると復帰）

---

## Phase 0: Mason Individual

**目的**: 確定白の共有者で盤面読解力（Seat Transformer backbone）を事前学習し、village モデルに転送する。

### なぜ mason か

| 比較軸 | 村人 1 席 | 共有者 1 席 |
|--------|----------|------------|
| 信頼度 | 疑われうる | 相互CO後に確定白 |
| 投票への影響 | 自分の 1 票のみ | plan が executionPlans として村全体に伝播 |
| 学習シグナル | 弱い（1/14 の投票影響力） | 強い（村全体の投票を制御） |

### 動作フロー

```
1. NN生成: village と同一アーキテクチャ (createTransformerNetwork)
2. 初期重み: Pretrain B+D の village 重みをコピー
3. ゲーム生成:
   - mlRoles=['mason'], mlMaxSeats=1
   - Seed Bank (Day 3 スナップショット) からリプレイ
   - MasonTrainingAdapter が mason の plan → executionPlans に注入
   - ヒューリスティック村人が executionPlans に従って投票
4. PPO update: strategy action head のみ (plan, predict)
5. eval: masonAsIndividual=true (team strategy をバイパス)
```

### mason の plan が村全体に伝わる仕組み

```
mason の NeuralAgent
  → decideVote (strategy-only)
    → getStrategyResult: unified plan logits を推論 (1日1回キャッシュ)
    → recordStrategy: trajectory に plan token + predict を記録
    → planToVote: plan logits → nooseCount ベースで投票先 seat に解決

MasonTrainingAdapter (extends StrategyBaseAdapter)
  beforePlanDistribution():
    → mason 生存時: NN の plan token → ext.planState に書き込み
  collectProposals():
    → mason 生存時: decideProposal → execute_order
    → mason 死亡後: planState[dayIndex] → resolvePlanGroup → execute_order
  StrategyBaseAdapter.onVote():
    → distributePlans(): planState → ext.executionPlans
    → 各プレイヤーの decideVote: ctx.executionPlans を参照してヒューリスティックが従う
```

### mason 死亡後の plan 継続

mason が噛まれた/吊られた後もキャッシュされた plan の残りスロットを nooseCount ベースで消費する。

```
Plan tokens (unified 12): [seat3, next, seat7, next, grayran, stop, ...]
  → slots[noose5]={seat3}   slots[noose4]={seat7}   slots[noose3]={grayran}

noose=5 (mason 生存): slots[5] → seat3 に execute_order
noose=4 (mason 死亡): slots[4] → seat7 に execute_order
noose=3 (mason 死亡): slots[3] → grayran → 先頭生存席
noose=2: スロットなし → ヒューリスティック投票
```

### Backbone Transfer

卒業後に全重みを village に転送:

```typescript
villageNet.loadWeights(masonNet.cloneWeights())  // 全重み (proj + seat + strat + heads + value)
refNetwork.loadWeights(masonNet.cloneWeights())   // KL reference network
tfNetwork.loadWeights(masonNet.cloneWeights())    // TF.js GPU network
```

同一アーキテクチャなので重み名が完全一致し、部分転送ではなく全転送。night head は mason で未使用だが、village の seer/bodyguard が後から学習する。

### 設定

| パラメータ | 値 | 説明 |
|-----------|---|------|
| mlMaxSeats | 1 | mason 2 席中 1 席のみ ML |
| MASON_MIN_ITER | 1000 | 最低学習 iter（早期卒業防止） |
| 卒業条件 | villager_won >= 55% | baseline と同値 |
| チェックポイント | `ckpt-mason_individual/` | final.json 存在で Phase 0 スキップ |

---

## Phase 1: Village

**目的**: 村陣営の個人モデルを学習。mason backbone の盤面読解力を引き継ぎ、plan token 戦略を洗練する。

### 動作フロー

```
1. 初期重み: Phase 0 mason から転送済み (warm start)
2. ゲーム生成:
   - mlRoles=['villager','seer','medium','bodyguard','nekomata']
   - mlMaxSeats=1 → 2 → ... → 6 (カリキュラム)
3. PPO update: strategy action head
4. KL penalty: mason backbone からの発散を抑制 (adaptive β, target=0.05)
```

### カリキュラム

| パラメータ | 初期値 | 進行条件 | 上限 |
|-----------|-------|---------|------|
| mlMaxSeats | 1 | villager_won >= baseline × 0.9 | 6 (村2+占1+霊1+狩1+猫1) |

### 報酬

- **Terminal reward**: ゲーム終了時の陣営勝敗
- **Intermediate reward**: 投票先の Retar 可能性に基づく評価 (endgameVoteReward)
- **Predict accuracy reward**: 配役予想の正解率

### Seed Bank

Phase 1 では Day 1 からフルゲームを実行する（mlStartDay は廃止済み）。

---

## Phase 1': 非村モデル

**目的**: frozen 村NN の出力を注入して、狼・狂信者・共有者(集団)・第三勢力を学習。

### 学習対象

| モデル | 役職 | 陣営勝率 | 特記事項 |
|--------|------|---------|---------|
| wolf_collective | werewolf | werewolf_won | frozen 村NN predict+trust 注入 |
| mason_collective | mason | villager_won | 集団NN（2人同時制御） |
| fanatic | fanatic | werewolf_won | 専用NN config、frozen 村NN 注入 |
| third | werehamster, immoralist | werehamster_won | - |

### Frozen 村NN 注入

```
village NN (frozen) ── forward(villageObs) ──→ predict[14×11] + trust[14]
                                                    ↓
wolf/fanatic の observation に per-seat 特徴量として concat
                                                    ↓
wolf/fanatic NN ── forward(extendedObs) ──→ 行動決定
```

### 卒業条件

各モデルの陣営勝率が baseline を超えたら卒業。全モデル卒業で Phase 2 へ。

---

## Phase 2: 自己対戦

**目的**: 全5モデルが互いに対戦して共進化。

（未実装）

