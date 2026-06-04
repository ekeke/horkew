# Migration: ResolvedRules → Regulation / AnalyzeOptions 統合

このドキュメントは、 horkew を consume するコードが以下 2 コミットに追従するための移行ガイドです。

| コミット | 内容 |
|---|---|
| `a17dad0` | types: ResolvedRules を Regulation にリネーム |
| `3b7fd5b` | retar: AnalyzeOptions に Regulation を統合してゲームルールを一元化 |

## なぜ変えたか

- `ResolvedRules` は howl パース過程の中間段階を強調した命名で、 horkew 横断のゲームルール型としては不適切。 `Regulation` の方が「ゲームの規定」 として retar / lupa / fenrir 等あらゆる subproject から自然に読める。
- retar が `AnalyzeOptions` 内部に `hasFirstGhost` / `seerFirstSeek` を独自に持っていたが、 これは `Regulation` の `general.first-victim` / `role.seer.first-seek` と意味的に重複していた。 retar の入口で一元化し、 prior pattern (`{ ...options, prior }`) での spread 引き継ぎが構造的に担保されるようにした。

## 1. 型名 / 関数名のリネーム

機械的置換で対応可能。

```ts
// BEFORE
import type { ResolvedRules } from 'horkew/types'
import { resolveRules } from 'horkew/howl/ruleset'

const rules: ResolvedRules = resolveRules({ 'vote.style': 'ordered' })

// AFTER
import type { Regulation } from 'horkew/types'
import { resolveRegulation } from 'horkew/howl/ruleset'

const regulation: Regulation = resolveRegulation({ 'vote.style': 'ordered' })
```

- `ResolvedRules` → `Regulation`
- `resolveRules()` → `resolveRegulation()`
- `defaultRules` (`howl/ruleset.ts` 内のローカル変数) → `defaultRegulation` (内部のため外部参照されていなければ影響なし)

**変えていないもの**:

- howl YAML の `meta.rules:` キー名 — frontmatter は引き続き `rules:` で書く
- `LupaConfig.rules`, `GameConfig.rules` 等の config object の field 名 — `rules:` で渡す

## 2. AnalyzeOptions の構造変更

retar の `AnalyzeOptions` から rule 重複フィールドを削除し、 `regulation` を required にしました。

### 削除されたフィールド

```ts
// BEFORE — これらは AnalyzeOptions から消えた
type AnalyzeOptions = {
  ...
  hasFirstGhost: boolean                                  // ← 削除
  seerFirstSeek?: 'none' | 'no-wolf' | 'all'              // ← 削除
  ...
}
```

### 追加された必須フィールド

```ts
// AFTER
import type { Regulation } from 'horkew/types'

type AnalyzeOptions = {
  regulation: Regulation                                   // ← required
  dayCountFrom: number                                     // ← 残置 (retar 固有)
  ...
}
```

- `regulation` は **required** です。 すべての caller で明示的に指定が必要。
- `dayCountFrom` は retar 固有 (ruleset の `omitFirstDay` とは独立) のため AnalyzeOptions に残置。
- `seerFirstSeek` は `regulation['role.seer.first-seek']` から内部で導出 (caller は意識不要)。
- `hasFirstGhost` は `regulation['general.first-victim'] !== 'none'` から内部で導出。

## 3. AnalyzeOptions 構築箇所の書き換え

retar が提供するヘルパー `defaultAnalyzeRegulation` / `firstGhostAnalyzeRegulation` を使います。

### default (初日犠牲なし、 seer 初夜は無制約)

```ts
// BEFORE
import type { AnalyzeOptions } from 'horkew/retar'

const options: AnalyzeOptions = {
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,           // ← 削除
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
  id: 0, batches: 1, batch: 0,
}

// AFTER
import type { AnalyzeOptions } from 'horkew/retar'
import { defaultAnalyzeRegulation } from 'horkew/retar/defaults'

const options: AnalyzeOptions = {
  regulation: defaultAnalyzeRegulation,   // ← 追加
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
  id: 0, batches: 1, batch: 0,
}
```

### 初日犠牲あり (14d-neko 系)

```ts
// BEFORE
const options: AnalyzeOptions = {
  ...
  hasFirstGhost: true,
  ...
}

// AFTER
import { firstGhostAnalyzeRegulation } from 'horkew/retar/defaults'

const options: AnalyzeOptions = {
  regulation: firstGhostAnalyzeRegulation,
  ...
}
```

### spread 上書きパターン

```ts
// BEFORE
const opts = cfg.hasFirstGhost
  ? { ...ANALYZE_OPTIONS, hasFirstGhost: true }
  : ANALYZE_OPTIONS

// AFTER
import { firstGhostAnalyzeRegulation } from 'horkew/retar/defaults'

const opts = cfg.hasFirstGhost
  ? { ...ANALYZE_OPTIONS, regulation: firstGhostAnalyzeRegulation }
  : ANALYZE_OPTIONS
```

### カスタム Regulation を作る場合

`resolveRegulation()` で部分指定から組み立てます。 未指定の field は `Rules` map の default に従います。

```ts
import { resolveRegulation } from 'horkew/howl/ruleset'

const customRegulation = resolveRegulation({
  'general.first-victim': 'random',
  'role.seer.first-seek': 'no-wolf',
  // 他は default
})

const options: AnalyzeOptions = {
  regulation: customRegulation,
  ...
}
```

## 4. howl scenario からの伝達経路

`.howl` の frontmatter で `rules:` を書くと、 自動的に retar の `regulation` に乗ります。 scenario 側の書き味は変わりません。

```yaml
---
title: ...
setup:
  werewolf: 1
  villager: 3
rules:
  general.first-victim: random           # ← scenario の rules 指定が
  role.seer.first-seek: no-wolf          #    retar 推論まで透過する
---
```

経路: `meta.rules` → `buildAnalyzeOptions(meta)` ([src/retar/expectations.ts](../src/retar/expectations.ts)) → `options.regulation` → `VillageRetar` コンストラクタ。

`meta.options.regulation` を明示指定した場合はそちらが優先されます (spread 順)。

## 5. WASM (retar-rs) との互換性

`serializeOptions` ([src/retar/wasm-helpers.ts](../src/retar/wasm-helpers.ts)) が内部で `regulation` から `hasFirstGhost` を導出して JSON に詰めます。 Rust 側の AnalyzeOptions struct は引き続き `hasFirstGhost` field を期待しているため、 WASM 呼び出し側は何も意識する必要なし。

ただし、 自前で `JSON.stringify(options)` して `analyze(...)` に渡している場合は変換が要ります。 整合性のため `wasm-helpers.ts` の `serializeOptions` を使うか、 `regulation` から手動で `hasFirstGhost` を計算してください。

```ts
// 自前で WASM に投げる場合の変換例
const { regulation, ...rest } = options
const hasFirstGhost = regulation['general.first-victim'] !== 'none'
const optJson = JSON.stringify({
  ...rest,
  hasFirstGhost,
  assumptions: Object.fromEntries(options.assumptions),
  hocusPocus: Object.fromEntries(options.hocusPocus),
})
```

## 6. prior pattern とのメリット

base run と prior run でルール一致が **構造的に担保** されるようになります。 引き回し忘れによる微妙な不整合が起こらなくなる。

```ts
// 同じ regulation が options に紐づいているので spread で自動的に運ばれる
const baseResult = new VillageRetar(vs, setup, options).analyze()
const priorRetar = new VillageRetar(vs, setup, {
  ...options,                       // ← regulation も自動的に同じものが入る
  assumptions: newAssumptions,
  prior: baseResult.result,
})
```

## 7. 検出と一括移行のヒント

```bash
# 影響箇所を機械的に検出
grep -rn "ResolvedRules\|resolveRules\|hasFirstGhost\|seerFirstSeek" src/ \
  --include="*.ts" --include="*.svelte"

# 単純なリネームは PowerShell / sed で一括可能
# - ResolvedRules → Regulation
# - resolveRules → resolveRegulation
# AnalyzeOptions の構造変更は文脈依存のため手動推奨
```

## 8. 注意: spread 上書きは typecheck で検出できない

`{ ...X, ... }` を経由した object に削除済みフィールドを書き足しても、 TypeScript の excess property checking は効きません。 つまり以下は **typecheck をすり抜けますが実行時には意図通り動きません**:

```ts
// typecheck pass してしまうが、 regulation は上書きされず default のまま
const opts = cfg.hasFirstGhost
  ? { ...ANALYZE_OPTIONS, hasFirstGhost: true }  // ← hasFirstGhost は AnalyzeOptions に存在しない
  : ANALYZE_OPTIONS

// VillageRetar は regulation を見るので、 hasFirstGhost: true は無視される
const retar = new VillageRetar(vs, setup, opts)
```

理由: spread した式は既に推論された型として扱われ、 余分な field を加えても supertype として AnalyzeOptions に互換扱いされるため、 excess property checking が外れる。

**移行時は grep で `hasFirstGhost` / `seerFirstSeek` の残存を機械的に潰してください**。 typecheck だけでは silent bug として残ります。

```bash
# 残存検出
grep -rn "hasFirstGhost\|seerFirstSeek" src/ --include="*.ts" --include="*.svelte"

# 真に残してよいのは以下のような lupa 側 config field のみ:
#   GameConfig.hasFirstGhost / LupaConfig.hasFirstGhost
#   scenarios の hasFirstGhost field
#   WASM 用の手書き JSON (serializeOptions を経由しない場合)
```

## 9. 参考

- 型定義: [src/types/index.ts](../src/types/index.ts) — `Regulation`
- 解決関数: [src/howl/ruleset.ts](../src/howl/ruleset.ts) — `resolveRegulation()`
- retar 用 default: [src/retar/defaults.ts](../src/retar/defaults.ts)
- 伝達経路 unit test: [src/retar/regulation.test.ts](../src/retar/regulation.test.ts)
