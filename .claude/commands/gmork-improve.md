---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
description: no-checker エントリを調査し、Gmork チェッカーの追加またはアノテーションを行う
---

# Gmork Improve ワークフロー

no-checker エントリ（Retar が判定したが Gmork が説明できないポイント）を調査し、チェッカーの追加・拡張またはアノテーション追加を行う。

## 引数

`$ARGUMENTS` = `<filename> <line|end>` (例: `mada4.howl 34`, `smabro2.howl end`)

## ステップ

### 1. 引数パースとファイル確認

引数から filename と line を分離する。

- `$ARGUMENTS` が空なら、使い方を表示して中断
- `src/retar/scenarios/<filename>` を Read で読む
- 見つからなければ `src/retar/scenarios/*.howl` を Glob で一覧して中断

### 2. no-checker エントリ取得

`tmp/gmork-no-checker.json` を Read で読み、該当チェックポイントのエントリをフィルタする。

- `file === filename` でフィルタ
- `line` の比較: 引数が `end` なら `entry.line === null`、数値なら `entry.line === 数値`
- **マッチなし**: JSON が古い可能性がある。以下を提案して中断:
  ```bash
  node --experimental-strip-types --test src/gmork/coverage.test.ts 2>&1 | tee tmp/coverage-output.log
  ```

### 3. ゲーム状態の解析

専用スクリプトでチェックポイント時点のゲーム状態を表示する:

```bash
node --experimental-strip-types src/gmork/inspect-checkpoint.ts <filename> <line|end> 2>&1 | tee tmp/inspect-output.log
```

### 4. 状況サマリー

ユーザーに以下を提示する:

1. **チェックポイント位置**: `filename:line`
2. **ゲーム状態**: スクリプト出力の要約（何日目、誰が生きていて誰が死んでいるか、CO状況）
3. **no-checker エントリ一覧**: 番号付きリスト
   ```
   [1] deny  プレイヤー名/role
   [2] confirm  プレイヤー名/role
   ```
4. **周辺のシナリオテキスト**: チェックポイント前後の行

### 5. ユーザーに質問

AskUserQuestion で以下を聞く:

「どのエントリに取り組みますか？ どんな理由で説明できそうですか？」

修正パスの案内を添える:
- **新チェッカー追加**: `src/gmork/checkers.ts` (deny) / `src/gmork/confirmers.ts` (confirm)
- **既存チェッカーの拡張**: 既存の reason type に新ケースを追加
- **アノテーション追加のみ**: チェッカーは既にあるが annotation が未記入の場合

### 6. 実装

ユーザーの回答に基づき、修正を実装する。

参考ファイル:
- `src/gmork/reasons.ts` — DenialReason / ConfirmationReason 型定義
- `src/gmork/checkers.ts` — 全 denial チェッカー（allCheckers 配列）
- `src/gmork/confirmers.ts` — 全 confirmation チェッカー（allConfirmationCheckers 配列）
- `src/gmork/CLAUDE.md` — カテゴリ設計 (axiomatic/dependent/elimination)
- `src/gmork/README.md` — 全 reason type カタログ

### 7. テスト

修正後、以下で検証する:

```bash
node --experimental-strip-types --test src/gmork/integration.test.ts 2>&1 | tee tmp/gmork-integration-output.log
```

integration test が通ったら、coverage を再測定:

```bash
node --experimental-strip-types --test src/gmork/coverage.test.ts 2>&1 | tee tmp/gmork-coverage-output.log
```

対象エントリが no_checker から explained に変わったことを確認する。
