# skoll-zero

skoll（世界列挙 + 1-step lookahead の評価器）を ISMCTS + NN に進化させた **評価器**。

## 一言で

`skoll-zero(盤面) → 勝率`。

判断を下す Agent ではない。skoll と同じく、盤面を受け取って勝率を返す純粋な評価関数。違いは「深く読めること」と「速いこと」。

| | skoll (オリジナル) | skoll-zero |
|---|---|---|
| 展開 | 全世界列挙 × 1-step lookahead | ISMCTS で深読み |
| 末端評価 | 決着までの再帰（heuristic 仮定） | NN value head |
| 探索の効率化 | なし（全世界総当たり） | NN policy head を prior にした PUCT |
| 得意 | 浅いが厳密 | 深いがサンプリング近似 |

## スコープ内: 盤面を確定的に変える意思決定

skoll-zero は以下の意思決定を **MCTS の枝として全探索で展開**し、policy head が PUCT の prior を与える。simulator は heuristic を持たず、全 action を呼び出し側（MCTS）が決めて渡す:

- **day**: 集団意思決定として処刑先 seat を選ぶ（1 seat）
- **night_attack**: 狼の噛み先選択
- **night_divine**: 真 seer の占い先選択
- **night_guard**: 真 bg の護衛先選択
- **claim** 系: 真 seer / medium / bg / nekomata / mason の CO / 潜伏選択、狼・狂の偽 CO 発動
- **偽結果報告**: 偽占い師 CO 済の狼/狂が「昨夜占った target と色」を meta 選択（毎朝）

## Phase 細分化

`SimState.phase` は 1 day-night cycle を以下の段に分解する（15 種）:

```
morning
  → claim_seer_true / claim_medium_true / claim_bg_true / claim_nekomata_true / claim_mason
  → claim_seer_fake / claim_medium_fake / claim_bg_fake / claim_nekomata_fake
  → day
  → night_attack / night_divine / night_guard
  → (simulateNight + outcome 判定)
  → terminal or 翌 morning
```

各 phase の扱い:

| Phase | 視点 | action | policy head | 即 skip 条件 |
|---|---|---|---|---|
| `morning` | 狼/狂（偽占い CO 済） | 昨夜占った target + 色 | `fake_target` + `fake_color` | 偽占い師 CO 不在 |
| `claim_*_true` | 真役職者 | CO / 潜伏 | `claim_true` (2 択) | 該当役職不在 or 他席が既 CO |
| `claim_*_fake` | 狼/狂 | 偽 CO 発動 / 見送り | `claim_fake` (2 択) | 該当役職を既 CO 済 or 狼/狂不在 |
| `day` | 集団意思決定 | 処刑先 seat | `execute` | （常に発生） |
| `night_attack` | 狼 | 噛み先（pending 記録） | `attack` | 狼全滅 |
| `night_divine` | 真 seer | 占い先（pending 記録） | `divine` | 真 seer 不在 |
| `night_guard` | 真 bg | 護衛先（pending 記録） + simulateNight | `guard` | 真 bg 不在 |
| `terminal` | — | （なし） | — | — |

### outcome 判定タイミング

- **day 終わり**（処刑直後）
- **night_guard 終わり**（夜 3 行動を `simulateNight` で一括解決してから）

夜の途中（attack / divine / guard の間）では outcome 判定しない。夜行動は同時処理で、結果は guard 後に一括解決する。

### pending state

夜フェーズの間、選んだが未適用の target を state に保持:

- `state.pendingAttack: number | null`
- `state.pendingDivineTargets: number[]`
- `state.pendingGuard: number | null`

night_guard 終わりに `simulateNight` で一括消費する。

### claim state

CO 履歴を state に保持:

- `state.claims: Map<seat, { role: SystemRole, isFake: boolean }>`
- 偽占い履歴: `state.fakeDivineHistory: Map<seerSeat, { day, target, color }[]>`
- 偽霊媒履歴: 同様
- 真占い結果は world 固定で自動導出（state には持たない or 観測時に導出）

## policy head vs 世界関数の役割分担

| 意思決定 / 遷移 | 世界固定で決まる？ | policy head | MCTS 分岐 |
|---|---|---|---|
| day 処刑先選択 | No（集団意思決定） | **あり** (`execute`) | 14 |
| 真占いの target 選択 | No（seer の戦略） | **あり** (`divine`) | 14 |
| 真占いの color 結果 | Yes（target の真 role） | なし | 1（決定論） |
| 偽占いの target 選択 | No（狼の戦略） | **あり** (`fake_target`) | 14 |
| 偽占いの color 選択 | No（狼の嘘） | **あり** (`fake_color`) | 2 |
| 噛みの target 選択 | No（狼の戦略） | **あり** (`attack`) | 14 |
| 噛みの成否（guard ブロック） | Yes（attack == guard） | なし | 1 |
| 護衛の target 選択 | No（bg の戦略） | **あり** (`guard`) | 14 |
| 真 CO / 潜伏選択 | No（戦略） | **あり** (`claim_true`) | 2 |
| 偽 CO の発動 | No（狼/狂の戦略） | **あり** (`claim_fake`) | 2 |
| 猫又道連れ等の連鎖死亡 | Yes（world 関数） | なし | 1 |

**ルール**:

- 世界固定 + state から決定論的に導出できる → **policy head 不要**、simulator が deterministic に処理
- 行動者が戦略的に選ぶ → **policy head あり**、MCTS の枝として展開

## NN 構造

Seat Transformer を幹に持つ 1 NN。共有 trunk の上に head が乗る。

- **trunk** — Seat Transformer（dModel=64、seatLayers=3 + strategyLayers=2）。seat ごとに 64-dim embedding を出す特徴抽出器
- **value head** — 陣営視点の勝率を scalar で返す（`[-1.3, 1]` レンジ、陣営別に faction で評価）
- **policy head** — phase 別の prior を出す。per-seat softmax（14 dim）または 2-dim 択

## 役職ファミリ別 Module

観測モードが異なるため、役職グループ別に **trunk の重みごと分けて**持つ。各 Module は担当 phase 分の head を持つ:

| Module | 観測モード | 担当役職 | heads |
|---|---|---|---|
| mason | mason_collective | mason | `execute` / `claim_true` |
| wolf | wolf_collective | werewolf | `execute` / `attack` / `claim_fake` / `fake_target` / `fake_color` |
| standard | individual | villager / seer / medium / bodyguard / nekomata | `execute` / `divine` / `guard` / `claim_true` |
| fanatic | individual | fanatic | `execute` / `claim_fake` / `fake_target` / `fake_color` |
| hamster | individual | werehamster | `execute` |
| immoralist | individual | immoralist | `execute` |

同じ head 名（`execute` / `claim_true` など）を複数 Module が持つが、重みは独立。MCTS の expansion は phase と視点から「どの Module のどの head を呼ぶか」を決める。

## MCTS の流れ

1. **Determinize** — Retar の可能性空間から 1 世界をサンプリング（`Determinizer.sample`）
2. **Root expand** — 開始 phase の policy head で prior 取得、Dirichlet noise 付与（exploration）
3. **Descent** — PUCT `Q + c · P · √N / (1 + N)` で最良枝を選び、`stepPhase` で 1 段進行
4. **Leaf 到達** — 未展開 leaf なら NN forward で value 評価、terminal なら outcome を value に
5. **Backup** — path に value を伝播、visits を積む

rollout を繰り返すと世界空間がサンプリングで平均化され、重要な行動選択の枝が優先的に訪問される。

### 世界空間の規模（参考）

14d-neko の初期世界数は 14! / (5! · 1! · 1! · 1! · 2! · 1! · 3! · 1!) = **60,540,480 worlds**。ISMCTS は全列挙せず、各 rollout で 1 世界だけ引いて木を広げる。Retar で可能性が削られるにつれて、実効的な世界空間は数万〜数百程度まで圧縮される。

## スコープ外: Agent 層で扱うもの

以下は **盤面を確定的に変えない** 発話的要素で、skoll-zero の MCTS には現れない。Shiba Agent（`src/fenrir/src/agents/shiba/`）がルールベースで処理する:

- **comm** — 議論中のシグナル（疑惑表明 / 信頼表明 / 告発 / 同意・反対）
- **target** — 議論中の指差し（偽占い先の言及、偽 mason 相方の指定）
- **propose** — 処刑提案
- **predict** — 最終配役予想
- **leader** — 指揮者応答

これらは「他者の行動確率を変える」情報戦要素で、盤面を確定的に変えない。Shiba Agent が決めるが、結果として生じる盤面変化（例: 提案が受け入れられて処刑先が変わる）は最終的に `execute` phase に集約される。

## 学習

**self-play + AlphaZero 流の outcome 学習**:

1. 現行 NN で ISMCTS を走らせながら self-play を回す
2. 各 phase の意思決定点で（盤面, MCTS visits 分布, 最終勝敗 z）を記録
3. バッチで `value ← z`（MSE）、`policy ← visits`（CE）を学習
4. 更新した NN で再度 self-play → 繰り返し

policy improvement が理論的な支柱: MCTS は現行 policy より賢い → その賢さを NN policy head に焼き付ける。

## Agent との関係

skoll-zero は評価器なので、単体ではゲームを進められない。消費する Agent が必要。Shiba Agent（`src/fenrir/src/agents/shiba/`）が skoll-zero + huginn を使う世代コードネーム:

```
Shiba Agent (判断者)
  ├─ skoll-zero (盤面評価器 + MCTS)
  │    各 decide* で対応する phase の MCTS を走らせて visits 分布を取る
  ├─ huginn (投票交渉エンジン、開発中)
  └─ ルールベース (comm / target / propose / predict / leader)
```

## ディレクトリ構成

```
src/skoll-zero/
├── simulator/      heuristic なしの純粋 simulator（世界関数で遷移）
├── mcts/           ISMCTS 本体 + determinize
├── network/        NN config と factory（mason / wolf / standard / ...）
├── module/         Module 層（NN + buffer + 推論をラップ）
├── selfplay/       self-play loop と Agent 実装
├── training/       trainer と multi-trainer
├── eval/           head-to-head
├── huginn-adapter/ 投票交渉 NN (huginn) との接続（Phase 4 で本統合）
└── phase/          fenrir orchestrate から呼ばれる phase runner
```

## 関連

- `src/skoll/` — オリジナルの評価器（skoll）
- `src/fenrir/src/agents/shiba/` — skoll-zero を使う Agent 世代（Shiba）
- `src/hati/` — 世界列挙 / 詰み探索（skoll/skoll-zero が内部で参照）
- `src/huginn/` — 投票交渉 NN（Phase 4 で Shiba に統合予定、別独立エンジン）
- `tasks/skoll-zero-architecture-overview.html` — アーキテクチャ全体図
- `tasks/skoll-zero-nn-architecture.html` — NN 構造の図解（trunk + head の役割分担）
- `tasks/skoll-zero-simulator-dynamics.html` — simulator 動作の図解（phase / MCTS / determinize）
