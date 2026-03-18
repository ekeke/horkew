# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Howl (Horkew OutLine Log) is a TypeScript parser for a domain-specific shorthand notation used to record Mafia/Werewolf game sessions. It parses `.howl` files (YAML frontmatter + compact game notation) into structured data. The notation supports both Japanese and ASCII syntax variants.

## Commands

```bash
npm test              # Run all tests with coverage (node:test, not Vitest/Jest)
npm run build         # TypeScript check + Vite library build
npm run dev           # Vite dev server
```

To run a single test file:
```bash
node --experimental-strip-types --test test/<file>.ts
```

## Architecture

**Parsing pipeline:** `parse(text)` → preprocess → parse each line → return `{meta, statements[]}`

Key modules in `src/`:
- **parser.ts** — Entry point. Orchestrates preprocess → per-line statement parsing
- **preprocess.ts** — Extracts YAML frontmatter, strips comments, splits spoiler annotations, normalizes lines
- **statement.ts** — Defines 8 statement types (`join`, `vote`, `multiVote`, `attack`, `lynch`, `revote`, `over`, `assert`) with individual parse functions tried in sequence
- **vocabulary.ts** — Regex patterns for arrow variants (`→ => ->` etc.), role/alignment keywords, supports hiragana/katakana normalization
- **flexibleDictionary.ts** — Fuzzy player name lookup (prefix, substring, 2-char omit matching)
- **ruleset.ts** — Game variant configuration (15+ boolean/choice/numeric rules)

Statement types use TypeScript discriminated unions keyed on `type`.

## Coding Conventions

- **No semicolons** at end of lines
- TypeScript files run directly via `--experimental-strip-types` (no tsc transpilation for execution)
- Type checking relies on VSCode, not build-time tsc
- Tests use `node:test` and `node:assert` — do not introduce other test frameworks
- Parsing uses named regex capture groups extensively
