# skoll-zero

skoll (世界列挙 + 1-step lookahead の評価器) を ISMCTS + NN に進化させた **評価器**。

## 一言で

`skoll-zero(盤面) → 勝率`。

判断を下す Agent ではない。skoll と同じく、盤面を受け取って勝率を返す純粋な評価関数。違いは「深く読めること」と「速いこと」。

| | skoll (オリジナル) | skoll-zero |
|---|---|---|
| 展開 | 全世界列挙 × 1-step lookahead | ISMCTS で深読み |
| 末端評価 | 決着までの再帰 (heuristic 仮定) | NN value head |
| 探索の効率化 | なし (全世界総当たり) | NN policy head を prior にした PUCT |
| 得意 | 浅いが厳密 | 深いがサンプリング近似 |

## skoll のシミュレーション内容を踏襲する

skoll が決着まで展開しているアクションは 4 種 (`src/skoll/winrate.ts` / `world-analysis.ts`):

- **vote** (処刑) — 評価対象。他は当面ランダム仮定
- **attack** (襲撃) — heuristic 仮定 (確定村優先、無ければグレー非狼非狐)
- **divine** (占い) — v1 では未モデル
- **guard** (護衛) — v1 では未モデル

skoll-zero はこの 4 種を **ISMCTS の木の中で展開**する。skoll の heuristic/ランダム仮定を、より賢い深読みに置き換えるのが存在意義。

### 検討中: 潜伏中役職の claim

真占い師・霊媒師・狩人などの **CO タイミング** (潜伏を解くか続けるか) は、MCTS の展開対象に加える候補。潜伏/公開の切り替えは以降の盤面遷移を大きく変えるため、skoll のシミュレーション範囲を拡張する意味がある。

一方、**偽 CO や発言種別、偽占い先、提案、予告、指揮応答**は skoll のシミュレーション対象外。これらは情報的な影響しかなく、盤面を確定的に変えない。MCTS で扱うものではない。

## NN の構造

Seat Transformer を幹に持つ 1 NN。出口は 2 系統:

- **value head** — 末端盤面の勝率評価 (スカラー、陣営視点)
- **policy head 4 種** — per-seat softmax × 4 (vote / attack / divine / guard)
  - MCTS の PUCT で prior として使う: `Q + c · P · sqrt(N) / (1 + N)`
  - 「手を選ぶ」ものではなく「探索を guide する」もの
  - 学習目標は self-play の MCTS visits 分布 (= policy improvement)

### 役職ファミリ別に NN 重みを分ける理由

同じ NN アーキテクチャでも、観測が異なるので NN 重みは役職グループ別:

| Module | 担当役職 | 観測モード | 特記 |
|---|---|---|---|
| Mason | mason | mason_collective | 相方席を観測可能 |
| Wolf | werewolf | wolf_collective | 仲間の狼・噛み履歴が見える |
| Village | villager / seer / medium / bodyguard / nekomata | individual | 自分の役職しか見えない |
| Fanatic | fanatic | individual | 狼情報は持たない |
| Hamster | werehamster | individual | 生き残り特化 |
| Immoralist | immoralist | individual | 狐情報あり |

## スコープ外 (skoll-zero には入れない)

以下は skoll/skoll-zero の評価器としての範囲外。Agent 層 (ルールベース or 別 NN) で処理する:

- **claim の種別** (seer_co / medium_co / mason_co 等の宣言種別そのもの)
- **comm** (議論中のシグナル: 疑惑表明・信頼表明・告発・同意/反対)
- **target** (偽占い先の指定、mason 偽相方の指定)
- **propose** (処刑提案)
- **predict** (最終配役予想)
- **leader** (指揮者応答)

これらは盤面を確定的に変えないため、skoll-zero のシミュレーションには現れない。Agent が決めるべきもので、skoll-zero はそれらの結果 (盤面への影響) を評価するだけ。

## Agent との関係

skoll-zero は評価器なので、それ単体ではゲームを進められない。消費する Agent が必要:

```
Agent (判断者)
  ├─ 投票を決める時: 各候補 vote について想定盤面を作り、skoll-zero で評価、argmax
  ├─ CO/発言を決める時: skoll-zero 非依存 (ルールベース or 別 NN)
  └─ 夜行動を決める時: 占い/護衛/襲撃の候補を skoll-zero で評価、argmax
```

既存の `SkollMasterAgent` (src/skoll/skoll-master-agent.ts) が skoll を評価器として使う Agent の雛型。skoll-zero を消費する Agent もこれと同じ構造でよい。

## 学習

**self-play + AlphaZero 流の outcome 学習**:

1. 現行 NN で ISMCTS を走らせながら self-play を回す
2. 各意思決定で (盤面, MCTS visits 分布, 最終勝敗 z) を記録
3. バッチで `value ← z` (MSE)、`policy ← visits` (CE) を学習
4. 更新した NN で再度 self-play → 繰り返し

policy improvement が理論的な支柱: MCTS は現行 policy より強くなる → その強さを NN policy head に焼き付ける。

## ディレクトリ構成 (現状)

```
src/skoll-zero/
├── simulator/      Level 1 軽量 simulator (hati ラッパー + heuristic policy)
├── mcts/           ISMCTS 本体
├── network/        NN config と factory (mason / wolf / standard の 3 種)
├── module/         Module 層 (NN + buffer + 推論をラップ)
├── selfplay/       self-play loop と Agent 実装
├── training/       trainer と multi-trainer
├── eval/           head-to-head
├── huginn-adapter/ 投票交渉 NN (huginn) との接続 (将来の Phase 4)
└── phase/          fenrir orchestrate から呼ばれる phase runner
```

## 現状コードとの乖離 (重要)

この README は **skoll-zero のあるべき純粋形** を記述している。現在のコードには Phase 2 以降で追加された以下の要素が混在しているが、これらは本来 skoll-zero の責務外:

- Phase 2 head (`claim` / `comm` / `target` / `propose` / `predict` / `leader` の 6 head)
- これらを学習するための Outcome-SL 系 API
- 上記を基礎にした Phase 2.5 consolidation (`skoll-zero-pretrain` curriculum)

これらは「Agent の判断を全部 NN に吸い込みたい」という別の欲求の結果で、skoll-zero の評価器としての純粋性を損なっている。将来これらは Agent 層 or 独立 NN として分離する方向で検討する。

## 関連

- `src/skoll/` — オリジナルの評価器 (skoll)
- `src/fenrir/src/agents/` — Agent 抽象 / ルールベース Agent
- `src/hati/` — 世界列挙 / 詰み探索 (skoll/skoll-zero が内部で参照)
- `src/huginn/` — 投票交渉 NN (将来 Phase 4 で合流予定、別独立エンジン)
- `tasks/skoll-zero-architecture-overview.html` — アーキテクチャ可視化 (Part A/B で内部/外部を整理)
