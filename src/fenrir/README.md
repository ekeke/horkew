# Fenrir — 強化学習による人狼 AI プレイヤー

Lupa ゲームエンジン上で PPO による自己対戦学習を行い、役職別ニューラルネットワークを訓練する。

## 公認プラン（Official Plan）

村陣営が共有する処刑計画。mason（共有者）の NN が生成し、村全体が従う Fenrir の基本ルール。

### 概要

公認プランは **12-token の Dual-direction plan** で構成される:

```
Forward (positions 0-7, L→R)     Endgame (positions 8-11, R→L)
├── slot[0]: 今日の処刑対象      ├── pos 11: 最終日の処刑対象
├── slot[1]: 明日の処刑対象      ├── pos 10: 最終日前日
├── ...                          └── ...
└── STOP: 終端
```

- **Forward**: 序盤〜中盤の処刑順序。slot 単位で日ごとに消費される
- **Endgame**: 終盤の処刑対象。生存人数ベースで参照され、消費されない

### 日送りルール

Forward slots は**毎日自動的に1つ消費**される（`StrategyBaseAdapter.afterVoteCollection`）。

```
Day 1: slots = [seat9, seat5, seat3]  →  planToVote → seat9
  afterVoteCollection: slots.shift()
Day 2: slots = [seat5, seat3]         →  planToVote → seat5
  afterVoteCollection: slots.shift()
Day 3: slots = [seat3]               →  planToVote → seat3
```

- **mason 生存時**: 翌日 `commitPlanTokens` で NN 出力に全上書きされるため、日送りは実質無影響
- **mason 死亡時**: cached plan の slots が日ごとに進行し、`slots[0]` が常に「今日の指示」を指す

### Endgame 保護

`endgameSlots[0]`（最終日用スロット）は生存 5-6 人の段階では**保護対象**として扱われ、処刑候補から除外される。最終日（生存 ≤ 4 人）になって初めて使用される。

### 投票先の決定

`planToVote()` が生存人数に応じて参照先を切り替える:

| 生存人数 | 参照先 | フォールバック |
|----------|--------|---------------|
| > 6 | `forwardSlots[0]` | null → heuristic |
| 5-6 | `endgameSlots[1]` | → `forwardSlots[0]` → `endgameSlots[0]` 除外ランダム |
| ≤ 4 | `endgameSlots[0]` | → `forwardSlots[0]` |
