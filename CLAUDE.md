# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Horkew is a werewolf（人狼）game analysis toolkit. Game state parsing, logical deduction, checkmate search, explainable reasoning, and game simulation — all in one TypeScript monorepo (with an optional Rust/WASM solver).

機械学習関連 (fenrir / skoll-zero / huginn / bloodhound) は `pre-ml-purge` タグの時点で本リポジトリから削除済み。 ML は別リポジトリで書き直す予定。

### Modules (`src/`)

| Module | 概要 |
|--------|------|
| **types** | 共有型定義。`SystemRole`, `VillageStatus`, `SeatStatus` など全モジュールの基盤 |
| **howl** | `.howl` 記法パーサー。YAML frontmatter + コンパクトなゲーム記法 → 構造化イベントデータ。日本語/ASCII 両対応 |
| **retar** | 役職推理エンジン（TypeScript）。リファレンス実装・開発のフロントライン |
| **retar-rs** | Retar の Rust/WASM 実装。本番用。Docker ビルド → Node.js/ブラウザ両対応 |
| **hati** | 詰み探索エンジン。AND-OR ゲーム木探索で村の必勝戦略を発見 |
| **lupa** | ゲームシミュレーション。プラガブルな GameHandlers インターフェースで完全な人狼ゲームを実行 |
| **skoll** | 役職確率推定。 enumerateWorlds をベースに per-X win rate / wolf vote 分析等を計算 |
| **verify** | retar / lupa 検証用の RandomAgent + agent-adapter |
| **spec** | lupa engine 振る舞いユニットテスト suite |
| **lykaon** | `.howl` エディタ + 解析サイドカーの Svelte 5 UI ライブラリ。`createAnalysisContext` + `EditorPane` を core に、`StatusPane` / `AnalysisTable` / `HatiPane` 等の optional ペインを並べて使う。詳細は [src/lykaon/README.md](src/lykaon/README.md) |

### Data Flow
```
HOWL (parse .howl logs)     LUPA (simulate games with RandomAgent)
  ↓                            ↓
VillageStatus ────────→ RETAR (solve possibilities)
                           ↓
                       Possibilities ────→ HATI (checkmate search)
                                       └→ SKOLL (probability / vote analysis)
```

### Retar 開発フロー (TS → Rust)

Rust版（retar-rs）が実運用ターゲット、TypeScript版（retar）がリファレンス実装兼開発のフロントライン。変更は以下の流れで行う:

1. **TS版を変更** — `src/retar/` のコードを修正・拡張
2. **TSテストをパス** — `npm test` でリグレッションなしを確認
3. **Rustへ一行単位で移植** — TS版の差分を `src/retar-rs/` に対応するRustコードとして忠実に転写
4. **Rustテストをパス** — `npm run test:rust` で正しさを検証
5. **WASM 配布成果物を更新** — Rust ソースに変更が入ったら `npm run build:wasm` で `pkg/` と `pkg-web/` を再生成し、 同一コミットで commit する。 lykaon / mirurou など WASM 経路の consumer は配布 wasm を bundle するため、 ソースだけ更新して配布物を放置すると古いバイナリのまま動作する

   この同期忘れを構造的に防ぐため、 husky 経由の commit-msg hook (`.husky/commit-msg`) が「Rust ソース (`src/retar-rs/src/*.rs`, `Cargo.{toml,lock}`) と配布 wasm (`src/retar-rs/pkg/`, `src/retar-rs/pkg-web/`) のどちらか一方だけが staged」 な commit を拒否する。 hook は `npm install` の `prepare` script (`husky`) で自動有効化される。 緊急回避として commit メッセージに `[wasm-skip]` タグを含めると bypass できる (例: 配布 wasm を後追い commit するフォローアップ等)

TS版とRust版はファイル構成・関数名を一致させる。TS版で設計・検証を済ませてからRustに移すことで、型システムの違いによるバグを最小化し、差分比較を容易にする。

### TS↔Rust 同一性規約

`src/retar/sync-check.test.ts` がファイル名・関数名・メソッド名の一致を静的に検証する。例外は最小限に保つ。

#### 命名規約
- **camelCase ↔ snake_case**: 自動変換で対応。`analyzeHamsterWin` ↔ `analyze_hamster_win`
- **モジュールプレフィックス**: TSのトップレベルexportではファイル名をプレフィックス/サフィックスに付ける（例: `enableDump`）。Rustではモジュールスコープで呼ぶためプレフィックス不要（例: `dump::enable`）。sync-check が自動認識する
- **コンストラクタ**: TS `constructor` ↔ Rust `new`（例外として許容）

#### 副作用の分離（mut規約）
Rustの `&self` / `&mut self` 分離パターンをTS側にも適用する:
- **読み取り専用**: `check...` / `validate...` — context を変更しない
- **変更あり**: `update...` / `apply...` — context の配列に push する等の副作用がある
- Rustでは `_fn` / `_fn_mut` の命名、TSでは動詞の使い分けで表現

例: `checkDeathCounts`（判定のみ）↔ `updateDeathCountConstraints`（判定 + requireOneOf への push）

#### アクセサ
- TSのpublicプロパティは getter/setter で実装し、Rustの pub getter メソッドと対応させる
- 例: TS `get initialPossibilities()` ↔ Rust `pub fn initial_possibilities(&self)`

### Legacy Directories

`howl/` と `common/` は外部プロジェクトから抽出した**リファレンス実装**。現在は `src/` 配下の統合版が正。

## Commands

### Root project (unified)
```bash
npm install
npm test                                     # node:test + node:assert with coverage
npm run build                                # tsc (typecheck only, noEmit)
npm run typecheck                            # tsc --noEmit
node --experimental-strip-types --test src/<file>.test.ts   # single test
```

### howl/ (reference)
```bash
cd howl && npm install
cd howl && npm test                          # node:test + node:assert with coverage
cd howl && npm run build                     # tsc + Vite lib build
node --experimental-strip-types --test howl/test/<file>.ts   # single test
```

### common/ (reference, retar)
No standalone build/test setup — reference implementation. Tests use Vitest patterns (expect/describe/it).

## Architecture

### Howl Parsing Pipeline
```
Input text → preprocess (YAML frontmatter extraction, comment stripping, spoiler splitting)
           → per-line statement parsing (tries each parser in sequence)
           → { meta, statements[] }
```

Key modules in `howl/src/`:
- **parser.ts** — Entry point, orchestrates the pipeline
- **preprocess.ts** — Frontmatter extraction, line normalization
- **statement.ts** — 12 statement types as discriminated unions (`join`, `joinMulti`, `vote`, `multiVote`, `attack`, `lynch`, `revote`, `over`, `assert`, `peace`, `reveal`, `unknown`)
- **vocabulary.ts** — Regex patterns for arrows, roles, species; handles hiragana/katakana normalization
- **flexibleDictionary.ts** — Fuzzy player name lookup (prefix, substring, 2-char omit)
- **ruleset.ts** — Game variant configuration (15+ rules)

### Retar
```
Game events → VillageStatus (village.ts) → VillageRetar (retar.ts) → Possibilities per seat
```

Key modules in `common/`:
- **village.ts** — Event-driven state reconstruction; updaters for vote, claim, assert, kill, execute
- **retar.ts** — Backtracking role assignment with bitmask-based possibility tracking
- **retar/possibilities.ts** — `Possibilities` class using `Uint16Array` bitmasks for role sets
- **retar/types.ts** — Core types: `SystemRole` (11 roles), `SeatStatus`, `VillageStatus`, `EnumSpecies`

The pipeline connection: Howl parser output → (mapped to events) → VillageStatus → Retar → per-player role possibilities.

## Performance (Hati / Retar)

Hati（詰み探索）とRetar（役職推理）は将来的に外部の機械学習パイプラインに組み込まれる前提のため、**パフォーマンスが最優先**。以下を厳守:

- **GC圧を最小化**: 不要なオブジェクト生成を避ける。ホットパスでの配列・オブジェクトの一時生成禁止。ビットマスク・Uint8Array・数値ハッシュで代替。
- **メモリ確保は遅延**: 大量データ（ワールド列挙など）は逐次処理（コールバック/ストリーミング）を基本とし、配列への一括収集は必要な場合のみ。
- **永続キャッシュ禁止**: モジュールスコープのMap等でゲームをまたいでデータを保持しない。メモ化は探索単位のスコープに限定。
- **枝刈りを先に**: 重い計算（ワールド列挙、探索）の前に安価なチェック（縄数、パリティ）で早期棄却。

## Coding Conventions

- **No semicolons**
- ESM (`"type": "module"`)
- TypeScript run directly via `node --experimental-strip-types` (no transpilation step for execution)
- Howl tests: `node:test` + `node:assert` — do not introduce other test frameworks into howl/
- Retar tests: Vitest patterns (expect/describe/it)
- Named regex capture groups used extensively in parsing
- Discriminated unions keyed on `type` field for statement and event types
- `tasks/` ディレクトリは `.gitignore` に含まれる（ローカル作業用、コミット対象外）
- **変数名・関数名を過度に省略しない**: `ctx`, `idx` 程度の定着した略語は可。`cand`（candidates）、`persp`（perspective）レベルの省略は避け、読んで意味が分かる名前にする
- **ドキュメントは常に最新に保つ**: コードを変更したとき、関連する CLAUDE.md・TrainingPhases.md 等のドキュメントに古いファイルパス・クラス名・関数名が残っていないか確認し、同じコミットまたは直後のコミットで更新する
- **丸数字（①②③…）の使用禁止**: 読みにくいため使わない。箇条書き番号は `1.` `2.` `3.` または `- ` を使う

## 役職追加ワークフロー (trait-purge 後)

trait-purge リファクタ完了 (commit `bc08c0f`) により、新役職追加は以下 2 箇所のみで完結する。retar / hati 内部の役職名列挙テーブル (`Liar` / `HumanRoles` / `ALL_ROLES` / `RoleSignatureBits` 等) は `systemRoles` から自動派生されるため、手動更新不要。

1. **TS** — [src/types/index.ts](src/types/index.ts) の `systemRoles` Map に entry を 1 つ追加。`SystemRole` リテラルユニオン、`faction`、`seerResult`、`mediumResult`、`traits[]` を埋めるだけ
2. **Rust** — [src/retar-rs/src/types.rs](src/retar-rs/src/types.rs) で 4 箇所更新:
   - `SystemRole::ALL` 配列 (TS の `systemRoles` 宣言順と完全一致させる)
   - `SystemRole::traits()` の match arm
   - `SystemRole::faction()` の match arm
   - `SystemRole::seer_result()` の match arm

TS / Rust の `systemRoles` 宣言順は **bit index 不変条件** のため厳守する (順序が変わると bit が動き WASM テスト失敗の原因になる)。

検証 & 配布:
- `npm test` (TS) + `npm run test:rust` (Rust)。 sync-check が TS↔Rust の関数名一致を自動検証する
- `npm run build:wasm` で `pkg/` と `pkg-web/` を**必ず再生成**し、 同一コミットで commit する。 これを怠ると mirurou など WASM 経路で「`unknown variant <new-role>` setup parse error」が発生し解析が走らない (新 variant は WASM 内 serde で deserialize されるため、 Rust ソースだけ更新しても配布 wasm が古ければ弾かれる)

詳細な経緯と Phase 1-11 の記録は [src/hati/Performance.md](src/hati/Performance.md) の「6. 役職追加コスト削減」「7. 役職追加コスト削減 - Rust 内部完遂」セクション参照。

## Domain Notes

The notation and vocabulary support dual Japanese/ASCII syntax:
- Arrows: `→`, `=>`, `->` (and reverse variants)
- Roles: 占い/seer, 霊媒/medium, 狩人/bodyguard, 共有/mason, 猫又/nekomata
- Species results: 白/○ (human), 黒/● (wolf)
- Game results: 村勝/villageWin, 狼勝/wolfWin, 狐勝/hamsterWin
- Player names use flexible matching with katakana↔hiragana conversion

## Development Stage

このプロジェクトはブートストラップ段階を抜け、**コンシューマ向け整備段階**に入った。GitHub Actions は以下が稼働している:

- [.github/workflows/ci.yml](.github/workflows/ci.yml) — push (main) / PR (main) で `typecheck` / TS `test` / Rust `cargo test` を並列実行
- [.github/workflows/deploy.yml](.github/workflows/deploy.yml) — main push 時に GitHub Pages へデモをデプロイ
- [.github/workflows/deploy-partykit.yml](.github/workflows/deploy-partykit.yml) — `party/` 変更時に PartyKit relay をデプロイ

ただし日常開発は引き続きローカル `main` 中心 (下記「ブランチ運用」参照)。 PR トリガーはコンシューマ向けに開けてあるが、 マスター自身は普段 PR を作らない。

### ブランチ運用

- 作業はすべて**ローカルの `main` ブランチ**上で直接行う（feature branch は使わない）
- 複数のエージェントが同時に異なる作業を進めることがある
- 意味的なコンフリクト（同じファイルの同じ箇所を変更するなど）の回避はユーザーが管理する

### コミット手順（ロックファイルによる排他制御）

複数エージェントの同時コミットによる競合を防ぐため、以下の手順を**必ず**守ること:

1. **ロック取得**: `mkdir .committing` を実行する（アトミックな操作）
   - 成功 → ロック取得完了、次へ進む
   - 失敗（既に存在） → **コミットを断念**し、ユーザーに報告して指示を仰ぐ
2. **ステージング**: 自分が変更したファイル**だけ**を `git add` する（`git add .` や `git add -A` は禁止）
3. **コミット**: `git commit` を実行する
4. **ロック解放**: `rmdir .committing` でロックを解放する

```bash
# 手順例
mkdir .committing                          # 失敗したらコミット断念
git add src/path/to/changed-file.ts
git commit -m "commit message"
rmdir .committing
```

**注意**: ロック取得後に失敗した場合も、必ず `rmdir .committing` を実行すること。

## Constraints

- ユーザーはPythonが嫌い。Pythonは使わない。
