# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Horkew is a Werewolf/Mafia game analysis toolkit consisting of two components being consolidated into a single TypeScript library:

- **Howl** (Horkew OutLine Log) — A parser for `.howl` shorthand notation (YAML frontmatter + compact game notation) that outputs structured game event data. Supports both Japanese and ASCII syntax.
- **Retar** — A logical deduction engine that takes game state and computes which roles each player could possibly hold, using constraint satisfaction and bitwise hypothesis testing.

The `howl/` and `common/` directories are **reference implementations** extracted from an external project. A new unified TypeScript project will be created at the repo root to consolidate them.

## Commands

### howl/
```bash
cd howl && npm install
cd howl && npm test                          # node:test + node:assert with coverage
cd howl && npm run build                     # tsc + Vite lib build
node --experimental-strip-types --test howl/test/<file>.ts   # single test
```

### common/ (retar)
No standalone build/test setup yet — these files were extracted as reference. Tests use Vitest patterns (expect/describe/it).

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
- **statement.ts** — 11 statement types as discriminated unions (`join`, `vote`, `multiVote`, `attack`, `lynch`, `revote`, `over`, `assert`, `peace`, `reveal`, `unknown`)
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

## Coding Conventions

- **No semicolons**
- ESM (`"type": "module"`)
- TypeScript run directly via `node --experimental-strip-types` (no transpilation step for execution)
- Howl tests: `node:test` + `node:assert` — do not introduce other test frameworks into howl/
- Retar tests: Vitest patterns (expect/describe/it)
- Named regex capture groups used extensively in parsing
- Discriminated unions keyed on `type` field for statement and event types

## Domain Notes

The notation and vocabulary support dual Japanese/ASCII syntax:
- Arrows: `→`, `=>`, `->` (and reverse variants)
- Roles: 占い/seer, 霊媒/medium, 狩人/bodyguard, 共有/mason, 猫又/nekomata
- Species results: 白/○ (human), 黒/● (wolf)
- Game results: 村勝/villageWin, 狼勝/wolfWin, 狐勝/hamsterWin
- Player names use flexible matching with katakana↔hiragana conversion
