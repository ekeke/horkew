# Fenrir 新アーキテクチャ設計

## 概観

3層構造の2つのNNで人狼AIを構成する。

```
┌─────────────────────────────────────┐
│ 戦略NN                              │
│                                     │
│  Seat Transformer（共有エンコーダ）    │
│    生の特徴量 → 席間関係の理解         │
│    ↓ seat embeddings + role embeddings │
│                                     │
│  Strategy Layer（戦略デコーダ）        │
│    席表現 → プラン + 推理 + CO方針     │
│    ↓ 構造化戦略出力                   │
└──────────────┬──────────────────────┘
               │ plan, predict, trust, co_policy, ...
               │ + seat embeddings（Step 3）
┌──────────────▼──────────────────────┐
│ 行動NN                              │
│                                     │
│  Action Layer（行動デコーダ）          │
│    戦略出力 + 文脈 → 投票・CO・夜行動  │
└─────────────────────────────────────┘
```

戦略NNは1日1回実行し、構造化された出力を返す。
行動NNは各フェーズで実行し、戦略出力を参照して具体的な行動を決定する。
2つの独立したNNなので、戦略NNだけ学習して行動側をルールベースにできる。

### なぜ3層・2NNか

| 層 | 解決する問題 |
|----|------------|
| Seat Transformer | 席間関係の構造的理解（MLPだとRetarとCOの関連をflatに学ぶ必要がある） |
| Strategy Layer | 学習速度（行動空間の縮小。プランと推理だけに集中できる） |
| Action Layer | 当日文脈への適応（シグナルを見て投票先を変える等） |

2NNに分ける理由: 戦略NNの出力を取り出してルールベース行動に渡す必要がある。
1つのNNだとforward passが全層を通ってしまい、途中で止められない。

---

## 戦略NN

### トークン構成

```
Seat Transformer入力:
  CLS (1)      グローバル特徴量
  Seat (14)    各プレイヤーの特徴量
  Role (5)     CO可能役職の集約表現
  ──────
  計 20トークン

Strategy Layer追加:
  Forward (8)   今日からの処刑プラン
  Endgame (4)   最終日からの逆算プラン
  ──────
  計 32トークン
```

#### CLS token

```
day, phase, alive_ratio, my_role(11), commander,
game_progress, demand_wolf_co_count, rope_margin, alive_parity
≈ 19次元
```

#### Seat tokens（14個、各 ~73次元）

```
基本 (25):          alive, claimed_role(12), is_me, black/white count,
                    vote_received, suspicion, trust, execute_proposal,
                    is_commander, accuse_wolf/fox, vote_intent, nominate_commander
自分視点Retar (11):  自分が持つ情報から計算した各役職の可能性
グローバルRetar (11): 公開情報のみから計算した可能性
Private知識 (5):     divine_result, wolf_teammate, mason_partner, guard_history, known_hamster
再投票候補 (1)
公認プラン (3):      plan_included, plan_position, plan_approved
新シグナル (4):      confirm_human, confirm_wolf, vote_for, vote_against
```

※ 騙り前提Retar（自分が偽物だと仮定した場合の可能性）は廃止。村NN出力注入で代替。

情報隔壁: gameState.players[].roleは直接参照しない。

#### Role tokens（5個）

学習可能な初期埋め込み。Self-AttentionでSeat tokensから情報を集約。
medium role tokenは「霊能CO者群」の集約表現になる。

#### Forward Plan tokens（8個）, Endgame tokens（4個）

学習可能な初期埋め込み + position encoding。
Strategy Layer内でseat/role embeddingsを見て処刑対象を決定する。

### アーキテクチャ

```
Seat Transformer（N層）:
  20トークン × 入力次元
    → Input Projection（トークン種別ごとにLinear → d_model）
    → [Self-Attention(4head) + LayerNorm + FFN(d→4d→d) + LayerNorm] × N層
    → 20トークン × d_model

Strategy Layer（M層）:
  20トークン(↑の出力) + 12トークン(Forward+Endgame) = 32トークン
    → [Self-Attention + LayerNorm + FFN + LayerNorm] × M層
    → 32トークン × d_model
    → 各トークンから出力読み出し
```

d_model=64, N=3, M=2 が基本構成。

### 出力

```
CLS token:
  co_policy:         softmax(8)    CO方針
  fake_target_hint:  Pointer(14)   偽結果対象候補（soft分布、人外のみ有効）
  fake_result_hint:  softmax(2)    偽結果の白/黒傾向（人外のみ有効）
  value:             tanh(1)       状態価値

Seat[i] token:
  predict[i]:        softmax(11)   この席の役職推理（全11役職の確率分布）
  trust[i]:          tanh(1)       信頼度（-1=人外確信, +1=村確信）

Forward[k] token:
  target[k]:         Pointer(22)   処刑対象

Endgame[k] token:
  target[k]:         Pointer(22)   最終日プラン
```

#### 役職推理（predict）の位置づけ

predictは補助タスクではなく**戦略NNの主要出力**。

- 戦略NNが推理を明示的に出力 → 内部表現が「各席の役職」を意識した構造になる
- 行動NNへの入力として渡す → 「seat3は狼だと思ってる」を行動NNが直接使える
- 訓練時: predict vs 実際の役職で補助損失（BCE × λ=0.1）
- 中間報酬: 村陣営のみ、正解席数/14 × 0.02

---

## 処刑プラン

### 語彙（22トークン）

Forward / Endgame のPointer語彙は共通:

```
softmax(14 seats + 5 roles + grayran + next + stop) = softmax(22)
```

| 出力 | 意味 |
|------|------|
| seat 1-14 | 特定の席を処刑 |
| seer | 占いCO者を1人処刑 |
| medium | 霊能CO者を1人処刑 |
| bodyguard | 狩人CO者を1人処刑 |
| mason | 共有CO者を1人処刑 |
| nekomata | 猫又CO者を1人処刑 |
| grayran | CO者以外から処刑 |
| next | 日の区切り |
| stop | プラン終了 |

### Pointer機構

Plan tokenの出力ベクトルをquery、対象tokensをkeyとして内積:

```
score_i = query(Plan[k]) · key(token_i) / √d
→ softmax over [Seat1..14, Role1..5, grayran, next, stop]
```

grayran / next / stop は学習可能な固定ベクトル。

### パース

nextとstopで分割 → 各グループが1日分:

- 単一要素 = 確定処刑
- 複数要素 = その日の選択肢（2択、3択）
- roleの出現日数 = 処刑人数（medium×2日 = ローラー、×1日 = 決め打ち）

Forward: 左→右に読む（先頭 = 今日）。
Endgame: 右→左に読む（先頭 = 最終日）。

### 例

```
「霊能ローラー → 占い決め打ち → グレラン」

Forward: [medium, next, medium, next, seer, next, grayran, stop]
          Day 2         Day 3         Day 4         Day 5
```

```
「前日: 狐候補2択 → 最終日: 確定狼処刑」

Endgame: [seat5, next, seat4, seat8, stop]
          最終日        前日
右→左: [seat4, seat8](前日) → [seat5](最終日)
```

### Forward / Endgame の切り替え

forwardを先頭から消費。残り日数がendgameの日数と一致したら切り替え:

```
Forward: [medium, next, medium, next, grayran, stop]   3日分
Endgame: [seat5, next, seat4, seat8, stop]              2日分

Day 2: forward → [medium]
Day 3: forward → [medium]
Day 4: 残り2日=endgame2日 → 切り替え → [seat4, seat8] 狐2択
Day 5: endgame → [seat5] 確定狼
```

呪殺でゲームが縮んでも endgame が独立しているので対応可能。

### 内部プランと公認プラン

```
内部プラン: 全員が出力。非公開。plan↔vote一貫性の補助損失で学習。
公認プラン: 指揮者（確定村=共有者）の出力。全員のobservationに注入。
            村陣営の投票を拘束（学習初期は完全拘束、成熟後は報酬誘導）。
            人外は自由投票 → 逸脱=人外の証拠。
```

---

## CO・騙りの意思決定

「COするか」は不可逆な戦略判断。「具体的な偽結果」は当日の文脈依存。
両NNに決定権を持たせる。

### 戦略NN → 方針

```
co_policy: softmax(8)
  no_co / seer_co / medium_co / bodyguard_co / mason_co / nekomata_co / werewolf_co / keep

fake_target_hint: Pointer(14)   偽結果の対象候補（soft分布）
fake_result_hint: softmax(2)    白/黒の傾向
```

村陣営がseer_co = 真CO。狼がseer_co = 占い騙り。出力形式は同一、意味が役職で変わる。
fake hints は人外のときのみ行動NNに渡す（村陣営は情報隔壁で遮断）。

### 行動NN → 最終決定

戦略のhintを受け取りつつ、当日のシグナル・文脈を見て最終決定:

```
入力: co_policy + fake hints + signals + seat embeddings(Step 3)
出力: claim行動 + target

例: 戦略=seer_co, hint=[seat5に黒寄り]
    → 行動NN: 当日の議論で「seat8の方が通りやすい」→ seat8に黒出し
```

---

## 行動NN

### 入力

```
戦略NNから（構造化出力）:
  forward plan:       8 tokens × Pointer(22)
  endgame plan:       4 tokens × Pointer(22)
  predict:            14 × 11         全席の役職推理
  trust:              14              信頼度
  co_policy:          8               CO方針
  fake_target_hint:   14              偽結果候補（人外のみ）
  fake_result_hint:   2               偽結果傾向（人外のみ）

ゲーム状態:
  per-seat:           14 × 25         基本情報
  signals:            シグナルカウンター群
  history:            直近3日分
  revote:             再投票情報
  phase:              現在のフェーズ

Step 3で追加:
  seat embeddings:    14 × d_model    Seat Transformerの出力を直接渡す
```

### 出力

```
vote:    softmax(14)     投票先
comm:    softmax(177)    シグナル選択
claim:   softmax(10)     CO行動
night:   softmax(15)     夜行動（14席 + none）
target:  softmax(14)     対象選択（占い先、護衛先等）
leader:  softmax(3)      指揮者応答（follow/defy/none）
propose: sigmoid(14)     処刑提案
```

### アーキテクチャ（学習段階で異なる）

| Step | Action Layer | 理由 |
|------|-------------|------|
| Step 1 | ルールベース | 戦略NNだけ学習。planに従って自動投票 |
| Step 2 | MLP or Transformer | 戦略NN固定。行動を教師あり+PPOで学習 |
| Step 3 | Transformer + GRU | 全層unfreeze。seat embeddings受け取り。日内文脈保持 |

Step 3のGRU:
```
各フェーズ:
  Action Layer入力 + h_prev → GRU → h_next → action heads
  日が変わったらhリセット
  → 「朝にseat3を疑った → 投票でseat3に入れる」の一貫性
```

---

## 報酬設計

### 訓練損失

```
total_loss = policy_loss
           + value_loss
           - entropy_bonus × 0.01
           + predict_loss × 0.1          ← 役職推理の補助損失（BCE）
```

### 中間報酬

```
役職推理報酬（村陣営のみ）:     正解席数/14 × 0.02   投票フェーズごと
plan↔vote一貫性（村陣営のみ）:  内部planと投票先一致 → +0.01
処刑成功:                      人外を処刑 → Plan tokenに正の報酬
処刑失敗:                      村人を処刑 → Plan tokenに負の報酬
```

人外は中間報酬なし。終端報酬(±1.0)で「バレずに勝つ」ことを学ぶ。

---

## ブートストラップ

### Step 1: 戦略NNのみ学習

```
戦略NN: PPO（Seat Transformer + Strategy Layer）
行動:   ルールベース（planに従って自動投票、co_policyに従ってCO）
投票:   村陣営は完全拘束
```

戦略の行動空間が小さい（Plan語彙22 × 12トークン + predict + co_policy）ため高速に収束。

### Step 2: 行動NNを学習

```
戦略NN: Step 1の学習結果を固定
行動NN: 教師あり（「planに従った投票」）+ PPO微調整
Seat Transformer: 重みを行動NNにコピーして初期化（状況理解を引き継ぐ）
```

行動NNが独自にSeat Transformer層を持つ場合、戦略NNから重みをコピーして初期化する。
これにより行動NNも初日から良質なseat embeddingsを使える。

### Step 3: 結合fine-tune

```
戦略NN: unfreeze
行動NN: unfreeze + GRU追加
インターフェース: 構造化出力 + seat embeddings（d_model次元）を直接渡す
投票拘束: 報酬誘導に緩和
Seat Transformer: 共有重み化して両方から勾配を流す
```

---

## ゲームフロー

```
Day N 開始
  │
  ├── COフェーズ
  │     行動NN: co_policy(前日の戦略)参照 → CO行動
  │
  ├── シグナルフェーズ × 複数ラウンド
  │     行動NN: trust + predict(戦略)参照 → シグナル発信
  │
  ├── ★ 戦略NN実行（1日1回）
  │     Seat Transformer: 20トークン → seat/role embeddings
  │     Strategy Layer: +12トークン → plan, predict, trust, co_policy, ...
  │     指揮者 → plan出力を公認プランとしてGameStateに記録
  │
  ├── 投票フェーズ
  │     公認プラン & 村陣営 → 自動投票(Step1) / 行動NN(Step2-3)
  │     人外 → 行動NNで自由投票
  │
  ├── 処刑
  │     Forward plan先頭を1日分消費
  │     処刑結果 → Plan tokenに報酬帰属
  │
  └── 夜フェーズ
        行動NN: 占い先、護衛先、襲撃先
        → Day N+1
```

---

## モデル構成

| モデル | 種別 | 役職 | 勝利条件 |
|--------|------|------|----------|
| **村個人** | 個人NN | villager, seer, medium, bodyguard, nekomata | villageWin |
| **狼集団** | 集団NN | werewolf | wolfWin |
| **共有集団** | 集団NN | mason | villageWin |
| **狂信者個人** | 個人NN | fanatic | wolfWin |
| **第三個人** | 個人NN | werehamster, immoralist | hamsterWin |

### 個人NN vs 集団NN

**個人NN**: 1席を1つのNNが担当。`my_role(11)` + Private知識 + Action maskで役職差異を吸収。
**集団NN**: チーム全員を1つのNNが同時に制御。全メンバーの私的知識を共有し、協調行動を直接出力。

### なぜ集団NNか

狼は本質的にチーム戦。「1匹が占い騙り、1匹が霊能騙り、1匹が潜伏」のような
立体的な役割分担は、個別のNNが独立に判断しても学習できない。
1つの脳が全員を同時に動かすことで、協調は出力の整合性として自然に出る。

共有者も同様に集団NNにする:
- CO互い（片方が先にCOし、もう片方が追従）
- 確定村として指揮権を取り、処刑プランを発信
- 投票の完全一致（確定村が割れると村が崩壊する）

### 狂信者が集団に入らない理由

狂信者は狼勝利が目的だが、狼と通信できない（狼は狂信者が誰か知らない）。
集団NNに入れると情報隔壁が壊れる。狂信者は独立した個人NNで、
knownWolves を入力に持ちつつ単独で狼を援護する。村NN出力注入も適用可能。

### 完全統一（1モデル）を採用しない理由

- **報酬の衝突**: 同じゲームで村+1/狼-1。共有trunkに矛盾した勾配が流れる
- **情報隔壁の複雑化**: 1モデルで村と狼を同時に学ぶと遮断が複雑になる

---

## カリキュラム学習（対戦相手の段階）

Step 1/2/3（NN構造のブートストラップ）とは**直交する概念**。
各Stepの中で、対戦相手を段階的に強くする。

| 段階 | 対戦相手 | 目的 |
|------|---------|------|
| Phase 1 | Heuristic（ルールベース） | 基本行動の獲得。`--ml-roles`で学習対象役職を限定可能 |
| Phase 2 | Self-play（全席ML） | ML同士の対戦で戦略の深化 |
| Phase 3 | Pool-based self-play | 過去5チェックポイントからランダムに対戦相手を選出。多様性維持 |

Step 1（戦略NNのみ）の中でPhase 1→2→3を回し、
Step 2（行動NN学習）でも同様にPhase 1→2→3を回す。

### PPOハイパーパラメータ（現行ベースライン）

```
γ = 0.99          割引率
λ = 0.95          GAE lambda
ε = 0.2           PPO clip
epochs = 4        ミニバッチ更新回数/iter
value_coeff = 0.5
entropy_coeff = 0.01
```

---

## 村NN出力の入力注入

### 動機

騙り中の人外は「本物っぽく振る舞いつつ、要所で裏切る」必要がある。
学習済み村NNの出力を人外NNに追加入力として渡すことで、
「本物の行動パターン」を参照しながら逸脱ポイントを学習させる。

### 適用対象

- **狼集団NN**: 各狼メンバーごとに村NNを実行し、per-seat特徴量として注入
- **狂信者個人NN**: 自席の観測で村NNを実行し、per-seat特徴量として注入

### 注入内容

各メンバー席の観測（村陣営として構築）→ frozen村NN forward:
```
→ predict[14×11], trust[14]
→ Seat token[i] に village_predict[i](11) + village_trust[i](1) を追加
```

メンバー席のSeat tokenには「自分の村NN出力」、非メンバー席には代表の村NN出力を注入。
推論コスト: 村NN forward × メンバー数/日（狼2-3回、狂信者1回）。

### 学習フロー

1. **Phase 1**: 村NNを vs ヒューリスティックで育てる → frozen
2. **Phase 1'**: frozen村NNを注入しつつ、狼集団 / 狂信者を学習
3. **Phase 2**: 全モデル自己対戦

---

## 未解決の設計判断

- **行動NNのSeat Transformer**: 戦略NNから重みコピーして独自に持つか、Step 3で共有重み化するか
- **comm headのPointer化**: signal_type softmax × Pointer(14) の分解方式
- **predict headの制約**: 配役の定員制約（villager×5, seer×1 等）をsoftmax(11)でどう扱うか
- **GRUの配置**: Action Layerのみか、Strategy Layerにも日をまたぐhidden stateを持たせるか
- **戦略の再計算**: 1日1回固定か、新情報が入ったら再計算するか
