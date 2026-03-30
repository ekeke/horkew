# Fenrir 開発メモ (claude.md)

## 学習対象役職

当面の目標では **possessed は学習対象外**。

### 3陣営モデル構成

| # | モデル | 役職 | チームNW |
|---|--------|------|----------|
| 1 | village | villager, seer, medium, bodyguard, nekomata, mason | mason_team |
| 2 | wolf | werewolf, fanatic | wolf_team |
| 3 | third | werehamster, immoralist | - |

- 3モデル並列で Phase 1 を同時学習 → Phase 2 で合流して自己対戦
- Seat Transformerが`my_role(11)` + Private知識 + Action maskで役職差異を吸収
- チーム戦略(wolf_team / mason_team)は所属モデルと一緒に学習（重みは別）
- Phase 1.5: チェックポイントが無いグループは heuristic フォールバック + PPO スキップ

### オーケストレーター (`npm run orchestrate`)

Phase 1 → Phase 2 を自動管理するスクリプト。

- baseline eval で heuristic の陣営別勝率を取得
- 3モデル並列起動、自陣営勝率が baseline を超えたら自動卒業 (`--target-winrate` / `--target-faction`)
- モデル終了時にコアを再配分（SIGTERM + --resume + --workers 増）
- 全 Phase 1 完了後に Phase 2 を自動起動
- 陣営マッピング: village→villageWin, wolf→wolfWin, third→hamsterWin
