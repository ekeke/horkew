---
allowed-tools: Bash, Read, Glob, Grep, Agent
description: Fenrir 学習セッション開始時のオンボーディング。現状把握と前セッションからの引き継ぎ
---

# Fenrir オンボーディング

新しいセッションで fenrir の学習アーキテクトとして作業を開始するための手順。

## ロール設定

あなたは機械学習のエキスパートで、fenrir プロジェクトのアーキテクトです。

## Step 1: 基本知識の読み込み

以下のファイルを**必ず**読む（並列で）:

1. `src/fenrir/CLAUDE.md` — モデル構成、学習パイプライン、キーモジュール
2. `src/fenrir/TrainingPhases.md` — 各フェーズの詳細設計
3. `src/fenrir/ActionAndReward.md` — 行動空間と報酬設計（存在する場合）

## Step 2: 現在の学習状況の把握

1. **アクティブな学習ジョブの確認**:
   - `tmp/orch-*` ディレクトリを一覧し、最新の checkpoint-base を特定
   - 最新の `progress.md` を読む
   - `eval_log.jsonl` から学習曲線の推移を確認

2. **eval howl の確認**（存在する場合）:
   - `{checkpoint-base}/eval-howl/` の最新 iter から数ゲーム読み、プレイ品質を把握

3. **実行中プロセスの確認はしない**:
   - `tasklist` や `ps` 等のプロセス確認コマンドは重いので実行禁止
   - eval_log.jsonl のタイムスタンプから稼働状況を推測すれば十分

## Step 3: 前セッションの引き継ぎ

1. `tasks/` ディレクトリにハンドオフ文書があるか確認:
   - `tasks/training-handoff-*.md` — 前セッションの作業記録（ファイル名: `training-handoff-{YYYYMMDD-HHmmss}.md`、最新のものを読む）
   - `tasks/todo.md` — 未完了タスク
   - `tasks/lessons.md` — 過去の教訓

2. memory の確認:
   - fenrir 関連のメモリを参照（project_fenrir_*, feedback_* など）

## Step 4: git 差分の確認

直近の git log を確認し、前セッションからの変更点を把握:

```bash
git log --oneline -20
git diff --stat HEAD~5
```

## Step 5: 状況サマリーの報告

以下をユーザーに報告:

1. **現在のフェーズ**: Phase 0/1/1'/2 のどこか
2. **学習進捗**: iter 数、eval 勝率の推移、卒業ラインとの距離
3. **懸念事項**: 学習曲線の異常、既知のバグ、パフォーマンス問題
4. **前セッションの未完了タスク**
5. **推奨アクション**: 次に何をすべきか

## 注意事項

- 学習ジョブが実行中の場合、コードの変更は次回再起動まで反映されない
- orchestrate.ts の変更は実行中プロセスに影響しない（別プロセス）
- `--resume` で途中から再開可能だが、pretrain はスキップされる
