---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
description: tmp/verify/ の失敗ケースを使って Retar のバグを調査・修正するワークフロー
---

# Retar 検証・修正ワークフロー

Lupa が生成した失敗ケース（`tmp/verify/*.howl`）を使い、Retar の推論バグを特定・修正する。

## 前提

- 失敗ケースは `tmp/verify/` に `.howl` ファイルとして配置される
- 各ファイルには `# @expect PlayerName: [role...]` アノテーションと `# 実際: ...` デバッグ出力がある
- Retar のシナリオテストは `src/retar/scenarios/*.howl` に置き、`src/retar/integration.test.ts` で実行される

## ステップ

### 1. 全ケースの一括テスト

まず `tmp/verify/` 以下の全ファイルを現在のコードでテストし、PASS/FAIL を確認する。

```bash
node --experimental-strip-types -e "
import { parse } from './src/howl/parser.ts'
import { buildVillageStatus } from './src/howl/bridge.ts'
import { VillageRetar } from './src/retar/index.ts'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
const dir = 'tmp/verify'
const files = readdirSync(dir).filter(f => f.endsWith('.howl'))
const options = {
  seerClaimingDueDate: 2, mediumClaimingDueDate: 2, bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2, nekomataClaimingDueDate: 99, dayCountFrom: 1,
  hasFirstGhost: false, assumptions: new Map(), hocusPocus: new Map(),
  id: 0, batches: 1, batch: 0,
}
for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf-8').replace(/\r\n/g, '\n')
  const expectLines = text.split('\n').filter(l => l.match(/^# @expect /))
  const gameLines = text.split('\n').filter(l => !l.startsWith('# @expect') && !l.startsWith('# 実際'))
  const gameText = gameLines.join('\n')
  const { statements, meta } = parse(gameText)
  const { vs, setup, players } = buildVillageStatus(statements, meta)
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyze()
  let allPass = true, failures = []
  for (const line of expectLines) {
    const m = line.match(/^# @expect (.+?):\s*\[(.+)\]$/)
    if (!m) continue
    const name = m[1], partial = m[2].endsWith('...')
    const expected = m[2].replace(/\.\.\./, '').split(',').map(r => r.trim()).filter(Boolean)
    const seat = [...players.entries()].find(([, n]) => n === name)?.[0]
    const actual = seat ? [...(result.result.get(seat) || [])].sort() : []
    const missing = expected.filter(r => !actual.includes(r))
    if (missing.length > 0) { failures.push(name + ': missing ' + missing.join(',') + ' in [' + actual.join(',') + ']'); allPass = false }
  }
  console.log((allPass ? 'PASS' : 'FAIL') + ' ' + file)
  if (!allPass) for (const f of failures) console.log('  ' + f)
}
"
```

### 2. 個別ケースの調査

FAIL したケースを1つ選び、以下のデバッグスクリプトで状況を把握する。

```bash
node --experimental-strip-types -e "
import { parse } from './src/howl/parser.ts'
import { buildVillageStatus } from './src/howl/bridge.ts'
import { VillageRetar } from './src/retar/index.ts'
import { readFileSync } from 'fs'

const text = readFileSync('tmp/verify/<FILE>.howl', 'utf-8').replace(/\r\n/g, '\n')
const gameLines = text.split('\n').filter(l => !l.startsWith('# @expect') && !l.startsWith('# 実際'))
const gameText = gameLines.join('\n')
const { statements, meta } = parse(gameText)
const { vs, setup, players } = buildVillageStatus(statements, meta)

console.log('result:', vs.result, 'finished:', vs.finished, 'day:', vs.day)
console.log('=== Deaths ===')
for (const [seat, s] of vs.statuses) {
  if (!s.surviving) console.log(seat, players.get(seat), 'day:', s.diedDay, 'cause:', s.causeOfDeath, 'claiming:', s.claimingRole)
}

const options = {
  seerClaimingDueDate: 2, mediumClaimingDueDate: 2, bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2, nekomataClaimingDueDate: 99, dayCountFrom: 1,
  hasFirstGhost: false, assumptions: new Map(), hocusPocus: new Map(),
  id: 0, batches: 1, batch: 0,
}
const retar = new VillageRetar(vs, setup, options)
console.log('lastDeaths:', retar.lastDeaths.map(s => players.get(s) + '(' + vs.statuses.get(s)?.causeOfDeath + ')'))
console.log('=== nightKillsByDay ===')
for (const [d, seats] of retar.nightKillsByDay) console.log('day', d, ':', seats.map(s => players.get(s)))
console.log('totalLiarRoles:', retar.totalLiarRoles, 'knownFakeClaimCount:', retar.knownFakeClaimCount)
const result = retar.analyze()
console.log('Debug:', retar.debugStash)
"
```

### 3. 問題の絞り込み

debugStash の値から問題箇所を特定する:

- **全員空（全 possibilities が空）**: 初期制約（`applyFixedPositions`, `applyGameEndConstraints`, `findLastDeaths`）か、`constrainByDeathCounts` の問題
- **特定の役職テストが 0 pass**: 該当する `testXxx` 関数のロジックに問題
- **`preFinalizeTests > 0, preFinalizePasses = 0`**: `constrainByDeathCounts` が全仮説を棄却。日ごとの expected/actual を確認
- **`finalizerRuns > 0, finalizerMiddle = 0`**: finalize 内の `markAsHuman` や role count チェックの問題
- **`finalizerMiddle > 0, finalizerPasses = 0`**: solver が全仮説を棄却。生存条件（surviving wolves/hamsters）の問題

### 4. 修正・テスト

1. 原因特定後、該当コードを修正
2. `node --experimental-strip-types --test src/retar/integration.test.ts` で既存テストが全 pass することを確認
3. ステップ1の一括テストで FAIL → PASS を確認

### 5. PASS したケースの処理

- PASS になった verify ファイルは `rm` で削除する（ユーザーの指示に従う）
- ユーザーがシナリオテストへの移動を指示した場合: `# 実際:` 行を除去して `src/retar/scenarios/` に適切な名前でコピー

### 6. コミット

ユーザーの指示に従い、修正をコミットする。

## 主要ファイル

| ファイル | 役割 |
|---|---|
| `src/retar/index.ts` | VillageRetar 本体。`findLastDeaths`, `applyGameEndConstraints`, `analyzeHamsterWin`, `tryFinalize` |
| `src/retar/roleTesters.ts` | 各役職テスター（`testSeer`, `testMedium`, `testNekomata`, `testHamster` 等） |
| `src/retar/finalizer.ts` | `constrainByDeathCounts`, `finalize`（solver 呼び出し） |
| `src/retar/planBuilder.ts` | roleTests 構築 |
| `src/retar/possibilities.ts` | ビットマスクベースの役職可能性管理 |
| `src/howl/bridge.ts` | Howl → VillageStatus 変換 |
| `src/retar/integration.test.ts` | シナリオテストランナー |
