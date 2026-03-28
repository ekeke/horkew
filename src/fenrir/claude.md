# Fenrir 開発メモ (claude.md)

## 学習対象役職

当面の目標では **possessed は学習対象外**。

### Phase 2 向け 6モデル分離

| # | モデル | 役職 | チームNW |
|---|--------|------|----------|
| 1 | mason | mason | mason_team |
| 2 | village | villager, seer, medium, bodyguard, nekomata | - |
| 3 | werewolf | werewolf | wolf_team |
| 4 | fanatic | fanatic | - |
| 5 | hamster | werehamster | - |
| 6 | immoralist | immoralist | - |

- 6コアCPU並列で Phase 1 を同時学習 → Phase 2 で6モデル合流して自己対戦
- village モデルが5役職を担当するため負荷が最も高い
- チーム戦略(wolf_team / mason_team)はそれぞれ werewolf / mason モデルと一緒に Phase 1 で学習
- Phase 1.5: `--phase2-models` でチェックポイントが無いグループは heuristic フォールバック + PPO スキップ。学習済みモデルだけ混合して段階的に ML 化できる

### オーケストレーター (`npm run orchestrate`)

Phase 1 → Phase 2 を自動管理するスクリプト。

- baseline eval で heuristic の陣営別勝率を取得
- 6モデル並列起動、自陣営勝率が baseline を超えたら自動卒業 (`--target-winrate` / `--target-faction`)
- モデル終了時にコアを再配分（SIGTERM + --resume + --workers 増）
- 全 Phase 1 完了後に Phase 2 を自動起動
- 陣営マッピング: mason/village→villageWin, werewolf/fanatic→wolfWin, hamster/immoralist→hamsterWin
