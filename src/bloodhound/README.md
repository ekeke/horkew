# Bloodhound

Pre-trained LLM (Claude Sonnet) を頭脳に、horkew の symbolic ツール (retar / skoll / hati / lupa) を Tool Use 経由で接続する **neuro-symbolic 人狼エージェント**。

## 命名

horkew の命名規則:
- **ツール = 神話の狼** (Skoll, Fenrir, Hati, Gmork, Lupa, Lykaon, Retar, Howl, Huginn …)
- **エージェント = 犬種** (Shiba, Bloodhound …)

Bloodhound = 嗅覚最強の探偵犬。隠された真実を追跡する推理の象徴。

## 他エージェントとの位置付け

| エージェント | 推論エンジン | 用途 |
|---|---|---|
| Fenrir agents | PPO 学習済み Transformer NN | RL 学習 + 自己対戦 |
| Shiba | skoll-zero (AlphaZero 系評価器) + huginn | self-play 学習可能 |
| **Bloodhound** | **Pre-trained LLM (Claude Sonnet) + Tool Use** | **対人プレイ / 評価 / 戦略立案** |

Bloodhound は **学習しない** (= pre-trained LLM を直接利用する) ことが他世代との決定的な違い。

## アーキテクチャ

```
Game state (lupa engine)
   ↓
Bloodhound Agent (1 seat 1 instance)
   ├─ system prompt: 人狼ルール解説 + 役職情報
   ├─ user prompt: 観測ログ + 状況 + 質問
   └─ tools (Anthropic Tool Use):
       ├─ retar(events)        → 各席の役職可能性
       ├─ skoll(state)         → 各陣営の勝率推定
       ├─ hati(state)          → 詰み判定 + 必勝戦略
       └─ lupa.simulate(...)   → what-if 仮想盤面
                  ↓
   LLM Decision: 発話 / CO / 投票 / 夜行動
                  ↓
   lupa engine handler 経由でゲームに反映
```

## ツール接続

| Skill | 入力 | 出力 | 提供元 |
|---|---|---|---|
| `retar` | 公開イベント列 | 各席の役職可能性 bitmask | [src/retar](../retar/) |
| `skoll` | 盤面 | 各陣営の勝率推定 | [src/skoll](../skoll/) |
| `hati` | 盤面 | 詰み判定 + 必勝戦略 | [src/hati](../hati/) |
| `lupa.simulate` | 仮想行動 | 仮想盤面 (what-if) | [src/lupa](../lupa/) |

LLM が苦手な離散最適化 (役職可能性列挙、詰み探索) を tool に委譲する。発話生成・嘘の見破り・戦略言語化など LLM が得意な仕事は LLM 本体で処理する。

## モデル

デフォルト: **Claude Sonnet 4.6** (`claude-sonnet-4-6`)

重要対局のみ Opus 4.7 を使用可。Haiku 4.5 / ローカル小型 LLM は推理品質が不足。
