# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Horkew is a werewolf（人狼）game analysis and AI toolkit. Game state parsing, logical deduction, checkmate search, explainable reasoning, game simulation, and reinforcement learning — all in one TypeScript monorepo (with an optional Rust/WASM solver).

### Modules (`src/`)

| Module | 概要 |
|--------|------|
| **types** | 共有型定義。`SystemRole`, `VillageStatus`, `SeatStatus` など全モジュールの基盤 |
| **howl** | `.howl` 記法パーサー。YAML frontmatter + コンパクトなゲーム記法 → 構造化イベントデータ。日本語/ASCII 両対応 |
| **retar** | 役職推理エンジン（TypeScript）。リファレンス実装・開発のフロントライン |
| **retar-rs** | Retar の Rust/WASM 実装。本番用。Docker ビルド → Node.js/ブラウザ両対応 |
| **hati** | 詰み探索エンジン。AND-OR ゲーム木探索で村の必勝戦略を発見 |
| **gmork** | 役職否定/確定の理由説明。Retar の結果を人間が読める日本語テキストに変換 |
| **lupa** | ゲームシミュレーション。プラガブルな戦略インターフェースで完全な人狼ゲームを実行 |
| **fenrir** | 強化学習（PPO）による AI プレイヤー。Lupa 上でゲームを回し、役職別ニューラルネットを訓練 |

### Data Flow
```
HOWL (parse .howl logs)     LUPA (simulate games)     FENRIR (train AI via PPO)
  ↓                            ↓                          ↓
VillageStatus ────────→ RETAR (solve possibilities) ← game decisions
                           ↓
                       Possibilities ────→ HATI (checkmate search)
                           ↓
                       GMORK (explain denials in Japanese)
```

### Retar 開発フロー (TS → Rust)

Rust版（retar-rs）が実運用ターゲット、TypeScript版（retar）がリファレンス実装兼開発のフロントライン。変更は以下の流れで行う:

1. **TS版を変更** — `src/retar/` のコードを修正・拡張
2. **TSテストをパス** — `npm test` でリグレッションなしを確認
3. **Rustへ一行単位で移植** — TS版の差分を `src/retar-rs/` に対応するRustコードとして忠実に転写
4. **Rustテストをパス** — `npm run test:rust` で正しさを検証

TS版とRust版はファイル構成・関数名を一致させる。TS版で設計・検証を済ませてからRustに移すことで、型システムの違いによるバグを最小化し、差分比較を容易にする。

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

Hati（詰み探索）とRetar（役職推理）は機械学習パイプラインに組み込む前提のため、**パフォーマンスが最優先**。以下を厳守:

- **GC圧を最小化**: 不要なオブジェクト生成を避ける。ホットパスでの配列・オブジェクトの一時生成禁止。ビットマスク・Uint8Array・数値ハッシュで代替。
- **メモリ確保は遅延**: 大量データ（ワールド列挙など）は逐次処理（コールバック/ストリーミング）を基本とし、配列への一括収集は必要な場合のみ。
- **永続キャッシュ禁止**: モジュールスコープのMap等でゲームをまたいでデータを保持しない。メモ化は探索単位のスコープに限定。
- **枝刈りを先に**: 重い計算（ワールド列挙、探索）の前に安価なチェック（縄数、パリティ）で早期棄却。
- **ベンチマーク必須**: `src/hati/bench.ts` でBEFORE/AFTERを計測し `src/hati/Performance.md` に記録。`src/hati/verify.ts` で正しさを検証。

## Coding Conventions

- **No semicolons**
- ESM (`"type": "module"`)
- TypeScript run directly via `node --experimental-strip-types` (no transpilation step for execution)
- Howl tests: `node:test` + `node:assert` — do not introduce other test frameworks into howl/
- Retar tests: Vitest patterns (expect/describe/it)
- Named regex capture groups used extensively in parsing
- Discriminated unions keyed on `type` field for statement and event types
- `tasks/` ディレクトリは `.gitignore` に含まれる（ローカル作業用、コミット対象外）

## Gmork (Role Reasoning Engine)

Gmork explains **why** a role is denied or confirmed for a player. It complements Retar (which computes **what** roles are possible).

### Architecture
```
VillageStatus + setup → findReason(seat, role)              → DenialReason | null
                      → findConfirmationReason(seat, role)  → ConfirmationReason | null
```

Key modules in `src/gmork/`:
- **index.ts** — Public API: `findReason`, `findConfirmationReason`, `explain`, `explainConfirmation`
- **checkers.ts** — Denial checkers (tiered: CO constraint → Tier 0 analysis → Tier 1 direct → Tier 2 combination → Tier 3 chained)
- **confirmers.ts** — Confirmation checkers + `deadWerewolfBounds` utility
- **analysis.ts** — CO bust analysis (seer/medium), independent of Retar
- **reasons.ts** — `DenialReason` / `ConfirmationReason` discriminated unions, checker input types
- **format.ts** — Japanese text formatting for reasons

### Key constraints
- `findConfirmationReason` does NOT use Retar's possibilities for the target player (to avoid circular reasoning), but MAY use them for other players (e.g. `dead_werewolf_count` confirmer)
- `cursed_by_killed_nekomata` (night bite) confirms werewolf; `cursed_by_executed_nekomata` (day execution) does NOT (random target)

### Scenario-driven testing with `@gmork` annotations

Gmork tests are embedded as comments in `.howl` scenario files (`src/retar/scenarios/*.howl`) and auto-discovered by `src/gmork/integration.test.ts`.

#### Annotation syntax

```
# @gmork-deny PlayerName/role: reason_type
# @gmork-deny PlayerName/role: outer_type > inner_type
# @gmork-confirm PlayerName/role: reason_type
```

- **`@gmork-deny`** — Asserts `findReason()` returns the specified denial reason type
- **`@gmork-confirm`** — Asserts `findConfirmationReason()` returns the specified confirmation reason type
- **`> inner_type`** — Additionally checks `bustReason.type` inside the reason (for `seer_claim_contradicted` / `medium_claim_contradicted`)
- **`: null`** — Asserts no reason is found (null)
- **Empty after `:`** (e.g. `# @gmork-deny Player/role:`) — **TODO marker**: always fails, reporting whether a reason was found and what type it was. Use this when adding annotations where you don't yet know the expected reason type.

#### Checkpoint behavior

Annotations are grouped into checkpoints (consecutive comment blocks). Each checkpoint runs against the **partial game text up to that point** (same as `@expect`). This means the game state at the checkpoint determines what gmork can reason about.

```howl
# These run against game state at this point in the file:
# @gmork-deny 闇さとし/seer: seer_claim_contradicted > result_contradicts_confirmed
# @gmork-confirm 闇さとし/immoralist: follow_hamster

# Game events continue below...
サターニャ処刑
```

#### Workflow for adding annotations

1. Add `# @gmork-deny Player/role:` or `# @gmork-confirm Player/role:` with empty reason
2. Run `node --experimental-strip-types --test src/gmork/integration.test.ts`
3. The test fails with either:
   - `アノテーション修正可: 理由は出せたがアノテーションに理由が未記入です。実際の理由: xxx` → Copy the reason type into the annotation
   - `理由が出せませんでした` → Gmork implementation needs to be extended
4. Fill in the reason type and re-run

## Domain Notes

The notation and vocabulary support dual Japanese/ASCII syntax:
- Arrows: `→`, `=>`, `->` (and reverse variants)
- Roles: 占い/seer, 霊媒/medium, 狩人/bodyguard, 共有/mason, 猫又/nekomata
- Species results: 白/○ (human), 黒/● (wolf)
- Game results: 村勝/villageWin, 狼勝/wolfWin, 狐勝/hamsterWin
- Player names use flexible matching with katakana↔hiragana conversion
