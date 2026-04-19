# skoll-zero

AlphaZero 系統の人狼 AI。policy/value head 両方を NN で学習し、ISMCTS で意思決定する。

設計書: `tasks/skoll-zero-design.md`
実装計画: `tasks/skoll-zero-impl-plan.md`

## ディレクトリ構成

```
src/skoll-zero/
├── simulator/   Level 1 軽量 simulator（hati ラッパー + heuristic policy）
├── mcts/        ISMCTS core（M2）
├── network/     mason_zero NN + warm start（M3）
├── selfplay/    self-play loop + Adapter（M4'）
├── training/    PPO に代わる AlphaZero 流 trainer（M5）
├── eval/        head-to-head + promotion（M6）
└── phase/       Phase 全体エントリポイント
```

## Phase 1 スコープ

- mason 単体から start
- 13 席 SkollMasterAgent（heuristic）固定、2 席 mason_zero NN
- vote + night actions のみ。CO/commander runoff 等は scope 外
- warm start: skoll-supervised pretrain trunk から（~191K params）
