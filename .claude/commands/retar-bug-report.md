---
allowed-tools: Bash, PowerShell, Read, Write, Edit, Glob, Grep, AskUserQuestion, TodoWrite, Agent
description: mirurou から届く retar バグレポートをクリップボード経由で取り込み、 再現→判定→優先度→修正の 4 レイヤーで処理する対話型ワークフロー
---

# /retar-bug-report — mirurou バグレポート処理ワークフロー

mirurou (lykaon 埋め込みホスト) から届く retar 解析不具合レポートを **クリップボード経由** で取り込み、 再現手順の確立 → バグ判定 → 優先度判断 → 修正実行の 4 レイヤーで処理する。 マスターの命令を復唱し、 各レイヤーの末尾で必ず承認を取ってから次へ進む。

## 入力形式

mirurou のコピーボタンで取得されるテキスト。 サンプル: [tmp/example.bugreport.txt](../../tmp/example.bugreport.txt)。 構造:

```
# 不具合の内容
<自然言語の不具合説明>

# 報告元
- 画面: <編集画面 / 解析画面 / ...>
- 村: <村名>

# 解析に渡された .howl 全文 (frontmatter の setup / rules 込みで自己完結)
\`\`\`howl
---
setup: { ... }
rules: { ... }
---
<.howl 本文>
\`\`\`
```

会話ペーストを迂回することで `.howl` 内の `#` コメント / `---` frontmatter / 全角文字 / コードフェンスの歪みが起きない。

## 前提

- 既存の `/verify-retar` ([verify-retar.md](verify-retar.md)) と相補的: こちらは **上流** で自然言語 → `.howl` + `@expect` を生成、 後段は verify-retar 系の資産をそのまま再利用
- `@expect` 構文の `!role` 否定 ([src/retar/expectations.ts:140-141](../../src/retar/expectations.ts#L140-L141)) と `@expect-deniedRoles` で大半の主張が表現可能 → 新規構文拡張ゼロ
- `tmp/bugreport/` は `tmp/` 配下 (gitignore 対象、 ローカル作業領域)
- マスターは git-bash 使用 (memory `reference_master_shell_gitbash`) — bash 例示を基本、 PowerShell が必要な箇所は明示

## Layer 1: 再現手順の確立

### 1.1 クリップボードから取得 + 保存 (audit trail)

```powershell
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$report = Get-Clipboard -Raw
```

スラグはマスターに 1 つ尋ねる (`AskUserQuestion` で 1 問のみ):
- 質問: 「このレポートに付ける短いスラグは？ (例: `siren3-bodyguard`)」
- スラグ無しなら `<ts>-untitled.txt` で進める

`tmp/bugreport/` を `New-Item -ItemType Directory -Force` で確保し、 `tmp/bugreport/<ts>-<slug>.txt` に raw 保存。

### 1.2 レポートのパース

raw テキストから 3 要素を抽出:

1. **不具合内容**: `# 不具合の内容` ヘッダーの次セクション (次の `# ` ヘッダー手前まで)
2. **報告元**: `# 報告元` セクションから 画面 / 村
3. **`.howl` 全文**:
   - 第一候補: \`\`\`howl ... \`\`\` フェンス
   - フォールバック: \`\`\` ... \`\`\` (言語ラベル無し) のうち `---` frontmatter or `++` 行を含むもの
   - 両方失敗したら STOP マスターに raw 提示して相談

### 1.3 `.howl` 単体保存

`tmp/bugreport/<ts>-<slug>.howl` に書き出す。 BOM / CRLF は LF に正規化 (`text.replace(/\r\n/g, '\n')`)。

### 1.4 Howl パース健全性確認 (retar↔howl 境界の切り分け)

retar に渡る前段で howl パーサ自体が正しく event を拾っているか確認する。 `verify-retar.md:81-84` のパターンを使う:

```bash
node --experimental-strip-types -e "
import { parse } from './src/howl/parser.ts'
import { buildVillageStatus } from './src/howl/bridge.ts'
import { readFileSync } from 'fs'
const text = readFileSync('tmp/bugreport/<ts>-<slug>.howl', 'utf-8').replace(/\r\n/g, '\n')
const { statements, meta } = parse(text)
const { vs, setup, players } = buildVillageStatus(statements, meta)
console.log('result:', vs.result, 'finished:', vs.finished, 'day:', vs.day)
console.log('setup:', JSON.stringify(setup))
console.log('=== Deaths ===')
for (const [seat, s] of vs.statuses) {
  if (!s.surviving) console.log(seat, players.get(seat), 'day:', s.diedDay, 'cause:', s.causeOfDeath, 'claiming:', s.claimingRole)
}
"
```

`causeOfDeath` の取り得る値 ([src/types/index.ts:116-136](../../src/types/index.ts#L116-L136)):
- `execution` / `night_kill` / `cursed_by_executed_nekomata` / `cursed_by_killed_nekomata` / `follow_executed_hamster` / `follow_killed_hamster` / `sudden_death`

**マスター確認**: 報告者の主張する事象 (e.g. 「平和発生」「呪殺」) が `causeOfDeath` / `vs.result` に正しく反映されているか。 反映されていなければ **howl パーサ側の問題** の可能性が高い → Layer 2 (b) に直行。

### 1.5 `# @expect` 変換

報告者の自然言語主張を annotation に翻訳する。 否定主張は `!role` を使う。

サンプル変換 ([tmp/example.bugreport.txt](../../tmp/example.bugreport.txt)):
- 主張: 「呪殺発生後の平和 → 狩人生存確定 → 死亡済み player の bodyguard 可能性が残っているのはおかしい」
- 翻訳: 死亡している全 player に対し `# @expect <Name>: [!bodyguard]`

`@expect-deniedRoles <Name>: [bodyguard]` も同等の表現 ([src/retar/expectations.ts:177-179](../../src/retar/expectations.ts#L177-L179))。 どちらを使うかは判定ロジック差分があれば差を確認、 無ければ `!role` で統一。

**マスター確認 (必須)**: 翻訳が報告者の意図を正しく汲んでいるか — 誤翻訳は後段全てを汚染する。 `AskUserQuestion` で翻訳案を提示して合意を取る。 翻訳確定後、 `tmp/bugreport/<ts>-<slug>.howl` の末尾に `# @expect` を追記。

### 1.6 再現確認 (現状 retar で FAIL するか)

`verify-retar.md:21-60` の inline script を流用、 path を `tmp/bugreport/` に差し替えて 1 ファイルだけ通す:

```bash
node --experimental-strip-types -e "
import { parse } from './src/howl/parser.ts'
import { buildVillageStatus } from './src/howl/bridge.ts'
import { VillageRetar } from './src/retar/index.ts'
import { readFileSync } from 'fs'
const text = readFileSync('tmp/bugreport/<ts>-<slug>.howl', 'utf-8').replace(/\r\n/g, '\n')
const expectLines = text.split('\n').filter(l => l.match(/^# @expect /))
const gameLines = text.split('\n').filter(l => !l.startsWith('# @expect'))
const gameText = gameLines.join('\n')
const { statements, meta } = parse(gameText)
const { vs, setup, players } = buildVillageStatus(statements, meta)
const options = {
  seerClaimingDueDate: 2, mediumClaimingDueDate: 2, bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2, nekomataClaimingDueDate: 99, dayCountFrom: 1,
  hasFirstGhost: false, assumptions: new Map(), hocusPocus: new Map(),
  id: 0, batches: 1, batch: 0,
}
const retar = new VillageRetar(vs, setup, options)
const result = retar.analyze()
for (const [seat, n] of players) {
  console.log(seat, n, ':', [...(result.result.get(seat) || [])].sort().join(','))
}
console.log('--- expects ---')
for (const line of expectLines) console.log(line)
"
```

- **FAIL する (期待通り再現)** → Layer 2 へ
- **FAIL しない (既に修正済み or 報告者の誤読)** → Layer 2 (c) (d) 直行

### 1.7 Layer 1 報告

マスターに以下を提示し、 Layer 2 への合意を取る:

- 保存先: `tmp/bugreport/<ts>-<slug>.{txt,howl}`
- 死亡者ダンプ (1.4 の出力)
- 翻訳された `@expect` (1.5)
- 再現の有無 (1.6)
- 自分の所感 (パース起因か推論起因か)

## Layer 2: バグかどうかの判定

報告者の論理を逐ステップで検証 (観察事実 → なぜ問題 → 原因 の順、 memory `feedback_explain_from_observation`)。

### 2.1 論理の組み立て

報告者の主張を「観察 → 推論ステップ → 結論」 に分解。 例:
- 観察: 「平和イベント @20:11 が呪殺発生後 (day N 朝の複数死体) に発生」
- 推論 1: 「狐 1 配役 + 他の複数死体は呪殺以外原因なし」
- 推論 2: 「平和 → 狩人 GJ → 狩人生存確定」
- 結論: 「死亡済み player は bodyguard を消去できる」

### 2.2 仕様照合

- CLAUDE.md / [src/types/index.ts](../../src/types/index.ts) の `systemRoles` で対象役職の能力定義
- [src/retar/scenarios/](../../src/retar/scenarios/) で類似ケース
- ruleset ([src/howl/preprocess.ts](../../src/howl/preprocess.ts) 等) で `general.first-victim` / `phase.lastwill` 等の影響

### 2.3 反例探索

報告者の論理に counterexample が無いか自分で考える:
- 「狼の自殺 (内訳: 猫又噛みで attack 0 の翌朝) を平和と区別できるか?」
- 「呪殺対象が複数になる setup (例: 狐複数) は除外されているか?」
- 反例があれば Layer 2 (c)、 無ければ (a)

### 2.4 分類

| 分類 | 内容 | アクション |
|---|---|---|
| (a) retar 論理エラー | 推論が仕様に対して不十分 / 過大 | Layer 3 へ進む |
| (b) howl パーサエラー | parse 段階で event 取りこぼし (1.4 で察知) | **STOP** マスター報告、 howl 修正は別スキル境界 |
| (c) 仕様通り (報告者の誤解) | 反例 or ハウスルール由来 | 説明添えて却下、 `tmp/bugreport/<ts>-<slug>.txt` 末尾に `# resolved: not-a-bug <理由>` を append |
| (d) 既知バグ重複 | 既に `tmp/verify/` or `src/retar/scenarios/` に同等 root cause | 既存に合流、 別ケース重複保存 |
| (e) ハウスルール / setup 依存 | 特定 ruleset でしか起きない | ruleset 拡張要否をマスター判断 |

### 2.5 Layer 2 報告

マスターに分類と論拠を提示、 合意を取る。 (b)(c)(d)(e) はここで停止。 (a) のみ Layer 3 へ。

## Layer 3: 優先度判断

(a) のみ進む。 修正コスト見積:

| 規模 | 目安 | 進め方 |
|---|---|---|
| small | 既存 `testXxx` ([src/retar/roleTesters.ts](../../src/retar/roleTesters.ts)) や `finalizer` の細い分岐追加、 数十行 | Layer 4 にそのまま進む |
| medium | 新しい制約 / 新しい retar 段、 100+ 行、 既存テスト影響可能性あり | 別途 plan 提案、 マスター合意待ち |
| large | アーキ的な変更 (新 phase, 新パイプライン) | 報告のみ、 別セッションへ送る |

### 影響範囲チェック

- `tmp/verify/` の他ケースに与える副作用 (verify-retar の一括 PASS/FAIL 差分を取る)
- typical 村構成 (14d-neko など) での頻度 (memory `feedback_always_14d_neko`)

### Layer 3 報告

コスト見積と方針をマスターに提示。 small ならそのまま着手、 medium 以上はマスター判断待ち。

## Layer 4: 修正実行

### 4.1 TS 修正

[src/retar/](../../src/retar/) のリファレンス実装 (memory `feedback_retar_ts_reference`: メモリ最適化は不要、 アルゴリズム改善のみ)。

主要編集対象:
- [src/retar/index.ts](../../src/retar/index.ts) — `findLastDeaths` / `applyGameEndConstraints` / `analyzeHamsterWin` / `tryFinalize`
- [src/retar/roleTesters.ts](../../src/retar/roleTesters.ts) — 各役職テスター
- [src/retar/finalizer.ts](../../src/retar/finalizer.ts) — `constrainByDeathCounts` / `finalize`
- [src/retar/planBuilder.ts](../../src/retar/planBuilder.ts) — roleTests 構築

### 4.2 既存テスト確認

```bash
node --experimental-strip-types --test src/retar/integration.test.ts
```

全 PASS が条件。 落ちたら **STOP**、 差分を `git diff --stat` でマスターに報告 (自動 rollback しない、 CLAUDE.md per master 指示)。

### 4.3 bugreport ケース確認

Layer 1.6 のスクリプトを再実行、 自分の `tmp/bugreport/<ts>-<slug>.howl` が FAIL → PASS することを確認。

### 4.4 シナリオへ昇格 (マスター合意)

`AskUserQuestion` で「このケースを `src/retar/scenarios/` に永続化するか?」 を確認。 Yes なら:

- ファイル名: 動詞-対象-結果 で命名 (e.g. `peace-after-curse-eliminates-bodyguard.howl`)
- 自然言語報告本文 / mirurou メタ (報告元 等) を除去
- `# @expect ...` のみ残す
- frontmatter の `setup` / `rules` は元のまま保持

### 4.5 Rust 移植 (memory `feedback_no_local_rust`)

[src/retar-rs/](../../src/retar-rs/) の対応箇所を **TS 側差分を一行単位で転写** (CLAUDE.md 「Retar 開発フロー」)。 ローカル `cargo` / `rustc` 禁止、 必ず Docker 経由:

```bash
npm run test:rust
```

47+ pass + sync-check (関数名一致) を確認。

### 4.6 コミット (CLAUDE.md 「コミット手順」厳守)

```bash
mkdir .committing                                    # 失敗したら STOP マスター報告
git add src/retar/<changed-files>                    # 個別追加、git add -A 禁止
git add src/retar-rs/src/<changed-files>
git add src/retar/scenarios/<new-scenario>.howl      # 4.4 で昇格した場合のみ
git commit -m "retar: <要約> (bugreport: <slug>)"
rmdir .committing
```

`tmp/bugreport/` 自体は `tmp/` 配下なので gitignore 対象、 コミット対象外。

### 4.7 bugreport の片付け

マスター指示で:
- `tmp/bugreport/resolved/` に移動 (履歴保持)
- or `rm tmp/bugreport/<ts>-<slug>.*` (clean up)

## エラー時の挙動 (CLAUDE.md per master 指示)

- いずれかの step で test / typecheck / 期待動作が崩れたら **STOP**
- `git diff --stat` と失敗内容、 失敗箇所のスニペットをマスターに報告
- 自動 rollback しない、 マスター判断を待つ
- 修正の試行錯誤を勝手に繰り返さない

## 対話原則

- 質問は 1 つずつ (`feedback_one_question_at_a_time`)
- 質問前にコード現状を Read / Grep で確認 (`feedback_no_naked_jargon`)
- 観察事実 → 問題 → 原因の順で説明 (`feedback_explain_from_observation`)
- 「確認して」と言われたら調査報告のみ、 勝手に修正実装しない (`feedback_no_stop_file`)
- 挙動異常はコード仮説より先に config (`setup` / `rules` frontmatter) を確認 (`feedback_check_config_first`)
- UI / 自然言語の文言は「死亡」でなく「退場」(memory `feedback_death_terminology`) — ただし `.howl` 仕様用語 `死亡` はそのまま使う

## 不変条件 / 落とし穴

- Layer 1.5 の `@expect` 翻訳は **必ずマスター確認** を経る — 誤翻訳が全レイヤーを汚染
- Layer 1-2 はマスター承認ゲートを必ず通す。 マスター不在で Layer 4 まで突き抜けない
- Layer 4.2 で既存テストが落ちる修正は **STOP**、 たとえ bugreport ケースが PASS になっても commit しない
- Layer 4.6 のコミットは個別 `git add`、 `git add -A` / `git add .` 厳禁
- ローカル `cargo` / `rustc` 禁止、 Rust テストは必ず `npm run test:rust` (Docker)
- `tmp/bugreport/` は gitignore 対象なので レポート本文は版管理されない — 重要な分析は `src/retar/scenarios/` 移動 or マスター記録に頼る
- 報告者 (mirurou 経由のエンドユーザー) の主張が誤っていても、 マスターに却下根拠を**明示的に提示**して合意を取る (黙って却下しない)
