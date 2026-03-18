# Project Guidelines

This workspace contains two independent TypeScript projects.

## Structure
- `howl/` — Howl (Horkew OutLine Log): parses `.howl` shorthand (YAML frontmatter + notation) into structured data.
- `common/` — Retar: analyzes Mafia/Werewolf village events to compute role possibilities.

## Build and Test
### howl/
- Install: `cd howl && npm install`
- Test: `cd howl && npm test` (uses `node:test` + `node:assert`)
- Build: `cd howl && npm run build` (typecheck + Vite lib build)
- Dev: `cd howl && npm run dev`

### common/ (retar)
- Install: `cd retar && npm install`
- Test: `cd retar && npm test` (Vitest)
- Typecheck: `cd retar && npm run typecheck`

## Conventions
- Keep dependencies isolated per project folder (avoid cross-imports between `howl/` and `common/`).
- Do not introduce new test frameworks into `howl/` (it intentionally uses `node:test`).
- Prefer minimal, surgical changes; avoid refactors unrelated to the task.

## Key Files
- Howl parsing entry: `howl/src/parser.ts`
- Howl CLI: `howl/cli.ts`
- Retar entry: `common/retar.ts`
- Retar village state/event model: `common/village.ts`
- Retar bitset possibilities: `common/retar/possibilities.ts`
