---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, TodoWrite
description: 新役職を systemRoles を起点に追加し、 TS / Rust / spec / engine の整合を保ったまま全モジュールで動く状態に持っていく対話型ワークフロー
---

# /add-role — 新役職追加ワークフロー

trait-purge 完成後の DRY 化された構造を前提に、 新役職を `systemRoles` を ground truth として全モジュールに反映する。 引数があれば初期ヒントとして利用 (例: `/add-role 牧師`)。

## 前提知識

- 役職追加 cost は **TS `systemRoles` 1 entry + Rust 4 match arm** で完結する設計 ([CLAUDE.md](../../CLAUDE.md) 「役職追加ワークフロー」 セクション参照)
- Howl / retar / hati は `systemRoles` 派生で自動追従、 触らない
- bit index 不変条件: `SystemRole` / `systemRoles` / `Rust SystemRole::ALL` は **APPEND only** (中間挿入禁止)
- TS↔Rust の値 (faction 等) は sync-check が関数名一致しか見ない → 値は手動同期

## ステップ 1: 仕様ヒアリング (対話モード)

`AskUserQuestion` で 1 つずつ確認 (まとめ質問禁止、 マスターの命令を復唱する)。

| 項目 | 質問内容 | デフォルト案 |
|---|---|---|
| 名前 3 種 | `name` (日本語、 例: 牧師) / `shortName` (1 文字、 例: 牧) / `systemName` (英語 lowercase、 例: priest) | 引数ヒントから推測した候補 |
| faction | `village` / `wolf` / `fox` のいずれか | - |
| alignment | `villager` / `werewolf` / `werehamster` のいずれか | faction から推測 |
| category | `villager` / `seer` / `medium` / `bodyguard` / `mason` / `werewolf` / `possessed` / `werehamster` / `fanatic` / `immoralist` / `other` | 近い既存役職から推測 |
| seerResult | `human` / `wolf` (デフォルト human) | 既存パターンから推測 |
| mediumResult | 同上 | 通常は seerResult と同じ |
| humanCount / wolfCount | 通常は 1/0、 狼系は 0/1、 狐は 0/0 | faction から推測 |
| description | 役職説明文 (改行可、 既存 entry の文体に合わせる) | - |
| traits | `RoleTrait[]` の配列。 既存 13 sub から選択 ([src/types/index.ts](../../src/types/index.ts) の TSDoc 参照) | - |
| howlPattern | 日本語/英語 alias を吸収する regex フラグメント。 `(?:<日本語 alias>\|<systemName>)` の形 | `name` + `shortName` + `systemName` から baseline 提案 |

## ステップ 2: TS 実装 (`src/types/index.ts`)

1. `SystemRole` union 型に **末尾追加** (例: `... | 'paparazzi' | 'priest'`)
2. `systemRoles` Map に **末尾追加** (12 番目以降、 既存 entry の order を変更しない)
3. `npm test` で構造的 regression が無いことを確認

注意: ここで test が大量に落ちる場合は、 step 4 (新 trait sub 検出) で engine 拡張が必要だった可能性。 マスターに報告して判断仰ぐ。

## ステップ 3: Rust 同期 (`src/retar-rs/src/types.rs`)

`Read` で現状を確認後、 4 箇所更新:
1. `SystemRole` enum variant 追加 (TS と同じ末尾位置)
2. `SystemRole::ALL` 配列に末尾追加
3. `SystemRole::traits()` の match arm 追加 (TS の `traits[]` と同じ内容)
4. `SystemRole::faction()` の match arm 追加 (TS の `faction` と同じ値)
5. `SystemRole::seer_result()` の match arm 追加 (TS の `seerResult` と同じ値)

`npm run test:rust` (Docker 経由) で sync-check 含めて 47+ pass 確認。

注意: ローカル cargo / rustc は使わない (master 規約)。 必ず `npm run test:rust`。

## ステップ 4: engine dispatch 必要性の判定

新役職の `traits` を 1 つずつ確認し、 「engine 観測可能な動作 (event emit / history 記録) が必要か」 判定:

| trait kind:sub | engine dispatch | 対応 assertion / 既存実装 |
|---|---|---|
| `action:divine` | 既存 (engine が seer 能力解決) | `@expect-divine` |
| `action:guard` | 既存 | `@expect-guard` |
| `action:attack` | 既存 | `@expect-attack` |
| `passive:attack-immune` | 既存 (silent + peace event) | `@expect-event peace` |
| `passive:die-when-divined` | 既存 | `@expect-event fox_kill` |
| `reactive:curse-on-executed` | 既存 | `@expect-event curse_kill` |
| `reactive:curse-on-killed` | 既存 | `@expect-event curse_kill` (attacker) |
| `reactive:follow-fox-death` | 既存 | `@expect-event follow_kill` |
| `auto-info:execution-species` | 既存 (mediumHistory dispatch) | `@expect-medium` |
| `knowledge:know-werewolves` | 既存 (buildPlayerView) | `@expect-view field:knownWolves` (役 fanatic 等) / `wolfTeammates` (役 werewolf) |
| `knowledge:know-foxes` | 既存 | `@expect-view field:knownHamster` |
| `knowledge:know-masons` | 既存 | `@expect-view field:masonPartner` |
| `channel:wolf-chat` | dispatch なし (player/agent 側で消費) | spec 対象外 |
| **新 sub (未知)** | 拡張必要 | 下記 ステップ 5 |

trait 全てが既存対応済みなら step 5 スキップ → step 6 へ。 1 つでも新 sub があれば step 5 必要、 マスターに報告して合意取ってから進む。

## ステップ 5: engine dispatch 拡張 (新 trait sub の場合のみ)

medium の `auto-info:execution-species` を追加した時のパターン (本リポジトリ commit `84d143c` 参照) に倣う:

1. `src/lupa/types.ts` の `PlayerState` に必要なら history field 追加 (例: `mediumHistory: Map<day, {target, result}>`)
2. `src/lupa/roles.ts` の `assignRoles()` で field 初期化
3. `src/lupa/engine.ts` の適切な dispatch ポイントで `hasTrait(role, kind, sub)` 分岐追加
4. `src/lupa/expectations.ts` に `@expect-<新assertion>` parser + verifier 追加 (`ViewExp` のような discriminated union を使う場合は `kind` 識別子で TS narrow を確実化)
5. **PlayerState mock の追従**: 新 field を持たない mock 作成 site が全てで type error 化するので、 全箇所追加:
   - 検索: `Grep "divineHistory: new Map()"` で似た構造の mock を発見
   - 既知の場所: `src/bloodhound/`、 `src/fenrir/src/adapters/command/`、 `src/fenrir/src/command-agents/`、 `src/skoll-zero/observation/`、 `demo/skoll-nn.ts` 等
6. `src/fenrir/src/seed-bank.ts` の `SerializedPlayerState` 型 + serialize / deserialize にも field 追加

検証: `npm run typecheck` 0 件、 `npm test` 全 pass。

## ステップ 6: spec scenarios 作成 (`src/spec/<systemName>/`)

各 trait の動作を「1 ファイル 1 目的、 15-25 行」 のユニットとして書く。

ファイル名規約: `<動詞>-<対象>-<期待結果>.howl`
- 例: `divines-werewolf-records-wolf.howl`
- 例: `curse-on-execution-emits-curse-kill.howl`

フォーマット (frontmatter + 進行 + assertion):
```howl
---
title: <平易な日本語で目的>
setup: { <役職>: 1, werewolf: 1, villager: N }
rules:
  first-victim: none  # 必要に応じて
---
# コメントで目的説明
# 即時終局シナリオで最小化

++Alice、Bob、...
!Alice=<役職名>
!Bob=人狼
...

Alice→Bob
...

# @expect-* 系 assertion
```

trait なし役職 (例: villager / possessed) は `src/spec/win-conditions/` で faction count 影響を間接カバー。

完了後 `node --experimental-strip-types --test src/spec/runner.test.ts` で新 spec が pass することを確認。

## ステップ 7: 検証

3 コマンドを順に:
1. `npm test` (期待: spec 増加分 pass、 0 fail、 13 todo)
2. `npm run typecheck` (期待: 0 件)
3. `npm run test:rust` (期待: 47+ pass)

**いずれかが失敗したら** STOP し、 マスターに報告して判断仰ぐ。 自動 rollback しない (per master 指示)。

## ステップ 8: ドキュメント生成 & コミット

1. `npm run gen-role-docs` (役職一覧 HTML を `demo/public/roles.html` に再生成)
2. `.committing` ロック取得 (`mkdir .committing`)
3. 個別ファイルを `git add` (`git add -A` 禁止):
   - 最小ケース (engine 拡張なし): `src/types/index.ts`、 `src/retar-rs/src/types.rs`、 `src/spec/<systemName>/*.howl`
   - engine 拡張ありの場合: 加えて `src/lupa/{types,roles,engine,expectations}.ts`、 全 PlayerState mock site、 `src/fenrir/src/seed-bank.ts`
4. `git commit` (タイトル: `role: <name> 追加`)
5. `rmdir .committing`

## エラー時の挙動 (per master 指示)

- いずれかの step で test / typecheck が落ちたら **STOP**
- 失敗内容と現状の差分 (`git diff --stat`) をマスターに報告
- 判断を待ってから次のアクション (修正 / rollback / 諦め) を決める
- 勝手に修正試行を続けない

## 不変条件 / 落とし穴 (再掲)

- `SystemRole` / `systemRoles` / `Rust SystemRole::ALL` は **APPEND only** (中間挿入で WASM bit index 崩壊)
- Howl 側 (`src/howl/`) は触らない (`systemRoles.howlPattern` 派生で自動追従)
- hati (`src/hati/`) は触らない (`role-attributes.ts` は systemRoles 派生)
- retar (`src/retar/`) は触らない (`role-sets.ts` は systemRoles 派生)
- TS↔Rust の値同期 (faction / seerResult 等) は手動、 sync-check は関数名のみ
- 既存テストや既存 spec を **書き換えない** (新規追加のみ)
