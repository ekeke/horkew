---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: cspell でスペルチェックし、カスタム辞書追加 or タイポ修正を行う
---

# Spellcheck ワークフロー

cspell を使ってプロジェクトのスペルチェックを行い、各指摘に対して辞書追加 or タイポ修正を実施する。

## 前提

- `cspell.json` がプロジェクトルートに存在すること
- `.cspell/custom-dictionary-workspace.txt` が辞書ファイル

## ステップ

### 1. cspell 実行

引数が指定されている場合はそのパス、なければプロジェクト全体を対象にする。
出力は `tmp/cspell-output.log` に保存する。

```bash
npx cspell lint --no-progress --no-summary --unique --gitignore ${ARGUMENTS:-.} 2>&1 | tee tmp/cspell-output.log
```

出力が空なら「スペルチェック問題なし」と報告して終了。

### 2. 結果の解析と分類

cspell の出力形式: `<file>:<line>:<col> - Unknown word (<word>)`

各ユニークな単語について、ソースファイルの該当行を Read で確認し、以下のいずれかに分類する:

**辞書追加（カスタム辞書に登録）:**
- モジュール名: howl, retar, hati, gmork, lupa, fenrir, horkew 等
- ドメイン用語: 人狼ゲーム関連の英語表現
- プログラミング用語: bitmask, frontmatter, TypeScript 関連等
- 固有名詞、略語、ライブラリ名
- ローマ字化された日本語
- camelCase/PascalCase の一部として使われている造語

**タイポ修正（ソースを修正）:**
- 明らかな英単語のスペルミス

判断に迷う場合は辞書追加を優先する（誤検知を減らすため）。

### 3. 辞書追加

1. `.cspell/custom-dictionary-workspace.txt` を Read で読む
2. 新しい単語を追加（重複排除、アルファベット順ソート、1行1単語で Write）
3. 先頭コメント行 `# Custom Dictionary Words` を維持する

### 4. タイポ修正

各タイポについて Edit で該当箇所を修正する。

### 5. 検証

修正・追加後、対象ファイルに対して cspell を再実行し、問題が解消されたことを確認:

```bash
npx cspell lint --no-progress --no-summary <修正ファイル...> 2>/dev/null
```

### 6. レポート

以下をまとめて報告:
- 辞書に追加した単語一覧
- 修正したタイポ一覧（元の単語 → 修正後、ファイル名、行番号）
- 残存する問題（あれば）
