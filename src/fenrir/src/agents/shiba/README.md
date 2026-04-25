# shiba

`ShibaAgent` は **skoll-zero（盤面評価器）+ huginn（投票交渉）を統合して使う Agent の世代コードネーム**。

## 一言で

ゲームに参加する 1 seat の判断者。内部で skoll-zero を評価器、huginn を投票交渉に呼び出し、発話的要素のみルールベースで補完する。lupa engine から見れば通常の Agent interface を実装した 1 Agent にすぎない。

## なぜ Shiba — 命名の趣旨

プロジェクトの既存モジュール名は狼とカラスに寄っている（`horkew` / `skoll` / `hati` / `fenrir` / `gmork` / `lupa` / `huginn`）。これらはすべて **評価器・探索器・エンジンといった「道具」** で、ゲームに参加して判断を下す「使い手」にあたる名前がなかった。

skoll-zero 開発の過程で「評価器に判断ロジックを詰め込みすぎる」失敗を重ね、Phase 2/3 で 6 head（claim / comm / target / propose / predict / leader）を同じ NN に詰めたものを丸ごと削除する純粋化リファクタ（commit `788a646`, 2026-04-24）に至った。**評価器（道具）と判断者（使い手）を名前レベルで永続的に分離する**ため、Agent 世代に固有名を与える。

- **Shiba**（柴犬）= 最初の世代名
- 狼から派生した犬というメタファー =「調教されて道具を使いこなす知性」
- 将来別の世代が必要になったら別の犬種で拡張する（Akita / Husky / Hokkaido / Laika など）

## 構造

```
ShibaAgent  (Agent interface を実装、1 seat = 1 instance)
  ├─ skoll-zero Module          盤面評価器（value + 複数 policy head + ISMCTS）
  │    役職ファミリ別:
  │      mason / wolf / standard / fanatic / hamster / immoralist
  │    扱う意思決定:
  │      execute / attack / divine / guard / claim_* / 偽結果報告
  ├─ huginn engine              投票交渉（execute の refine に使う、signal / desire / knowledge プロトコル）
  └─ ルールベース処理           comm / target / propose / predict / leader のみ
```

**単一 `ShibaAgent`、内部で役職別の Module と observation encoder を dispatch する** 設計とする。継承で役職別具象クラスを作らない。

理由: Agent の挙動自体は全役職共通で、役職差は「観測モード」と「どの Module / どの policy head を呼ぶか」だけ。継承でクラスを並べると Phase 2/3 純粋化で捨てたのと同じ責務分散が再発しやすい。

## 責務分担

ShibaAgent は lupa の Agent interface に準じた `decide*` 系を実装する。内部で呼び分ける先:

| 意思決定 | 使う道具 | 備考 |
|---|---|---|
| execute（処刑先） | **skoll-zero** + huginn 交渉 | `execute` phase の MCTS。huginn 未整備なら skoll-zero 単独 |
| attack（狼の襲撃） | **skoll-zero** | `night_attack` phase、`attack` head |
| divine（占い先） | **skoll-zero** | `night_divine` phase、`divine` head |
| guard（護衛先） | **skoll-zero** | `night_guard` phase、`guard` head |
| 真 CO / 潜伏選択 | **skoll-zero** | `claim_*_true` phase、`claim_true` head |
| 偽 CO 発動 | **skoll-zero** | `claim_*_fake` phase、`claim_fake` head |
| 偽占い target / color | **skoll-zero** | `claim_seer_fake` / `morning` phase、`fake_target` / `fake_color` head |
| comm（議論中のシグナル） | ルールベース | 盤面を確定変更しない情報戦要素 |
| target（議論中の指差し） | ルールベース | 同上 |
| propose（処刑提案） | ルールベース | 同上 |
| predict（配役予想） | ルールベース | 同上 |
| leader（指揮者応答） | ルールベース | 同上 |

`comm` / `target` / `propose` / `predict` / `leader` は **盤面を確定的に変えない** 発話的要素で、skoll-zero の MCTS には現れない（`src/skoll-zero/README.md` の「スコープ外」参照）。これらは Shiba がルールベースで処理する。将来別の小型 NN に置き換える余地はあるが、それは別世代の責務として切り出す（別犬種）。

## 依存

- `src/skoll-zero/` — 評価器 Module 本体と MCTS、phase 遷移
- `src/huginn/` — 投票交渉エンジン
- `src/fenrir/src/agents/agent.ts` — Agent interface（基底）
- `src/lupa/` — ゲームエンジン（Agent を呼び出す側）

## Shiba が実装しない範囲

- **学習ループ** — fenrir `orchestrate.ts` が扱う。Shiba は学習時・inference 時ともに同じ Agent 実装として振る舞う
- **評価器の設計** — skoll-zero 側の責務（value head / policy head / MCTS / phase 遷移）
- **交渉プロトコル** — huginn 側の責務（signal 語彙 / desire / knowledge / 投票集約）
- **observation encoder の実装** — skoll-zero / huginn 側で持つ。Shiba は入力パイプラインを繋ぐだけ
- **claim / execute / 夜行動の戦略判断** — skoll-zero の phase 単位 MCTS で決まる。Shiba は visits 分布から action を取り出すだけ

## 既存 Agent との関係

| 既存 Agent | 配置 | Shiba との関係 |
|---|---|---|
| `SkollZeroRoleAgent` 系 | `src/skoll-zero/selfplay/` | skoll-zero の self-play 学習専用。Shiba とは別系統として並列に残す |
| `SkollMasterAgent` | `src/skoll/` | skoll（非 zero）を使う Agent の祖型 |
| `NeuralAgent` 系 | `src/fenrir/src/agents/` | 旧世代（pure transformer 自己対戦）の Agent。Phase 0/1/1' 系の学習対象 |
| `RuleBasedAgent` | `src/fenrir/src/agents/` | ルールベースフォールバック |

ShibaAgent は **旧 NeuralAgent / SkollZeroRoleAgent を即時に置き換えない**。新世代として並列追加し、機能検証の後で役割分担を整理する。

## 未決事項

- 既存 `SkollZeroRoleAgent` を将来 Shiba に統合するか、self-play 学習専用として並列に残すか
- `comm` / `target` / `propose` / `predict` / `leader` を別 NN に昇格する際の配置（別犬種モジュールとして切り出すか、Shiba 内部で吸収するか）
- 学習時の扱い（Shiba 自身を self-play 対象にするか、構成要素の NN だけ学習して Shiba はランタイム組み合わせに徹するか）

## 今後の拡張

別世代が必要になった時のための犬種候補:

- `Akita` — 忠実・シンプル・響きがクリーン
- `Husky` — 狼に最も近い犬種、北欧圏と親和
- `Hokkaido` — アイヌ犬、プロジェクト起源（horkew = アイヌ語の狼）と直結
- `Laika` — ロシア語で「吠える」、宇宙犬、先駆者ニュアンス

各世代ごとに **使う評価器・交渉エンジン・学習方針の組み合わせ** を README に明記することで、世代間の設計差を後から追跡可能にする。

## 関連ドキュメント

- `src/skoll-zero/README.md` — 評価器としての純粋な定義、phase 細分化、scope の明示
- `src/fenrir/CLAUDE.md` — fenrir 全体の学習パイプライン
- `tasks/skoll-zero-architecture-overview.html` — skoll-zero アーキテクチャ可視化（Part A / B）
- `tasks/skoll-zero-nn-architecture.html` — NN 構造の図解
- `tasks/skoll-zero-simulator-dynamics.html` — simulator 動作の図解（phase / MCTS / determinize）
