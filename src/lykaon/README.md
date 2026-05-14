# lykaon — howl 解析 UI ライブラリ

Horkew の `.howl` 形式ログを **編集 / 表示 / 解析** するための Svelte 5 + Vite 製の UI モジュール。`createAnalysisContext()` で共有 state を作り、ペインに `ctx` を渡すだけで以下が動く:

- **EditorPane** — CodeMirror 6 ベースの `.howl` エディタ (シンタックスハイライト、補完、時刻ボタン)
- **StatusPane** — 生存者・投票・襲撃・カミングアウト・死亡履歴の集約表示
- **HatiPane** — 詰み探索結果の表示
- **InspectPane** — fenrir/skoll の game ログ閲覧 (時系列・retar スナップショット)
- **GmorkDebugPane** — 役職否定/確定の理由説明デバッグ

解析エンジン本体 (`howl` パーサー、`retar` 役職推理、`hati` 詰み探索、`gmork` 説明) はこの lykaon の依存先として呼び出される。

## 前提

- **Vite 専用**: `?worker` / `?url` import 構文を使うため、consumer 側も Vite ビルド必須
- **Svelte 5**: runes (`$state` / `$derived` / `$effect`) を要求
- **TypeScript**: ソースコードを直接 export (pre-built bundle は提供しない)

## 基本的な使い方

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    createAnalysisContext,
    EditorPane, StatusPane, HatiPane, InspectPane, GmorkDebugPane,
  } from 'horkew/lykaon'
  import 'horkew/lykaon/theme.css'

  const ctx = createAnalysisContext()
  onDestroy(() => ctx.destroy())
</script>

<EditorPane {ctx} />
<StatusPane {ctx} />
<HatiPane {ctx} />
<InspectPane {ctx} />
<GmorkDebugPane {ctx} />
```

これだけで、EditorPane で `.howl` を編集すると即座に StatusPane / HatiPane に解析結果が反映され、StatusPane の行クリックで EditorPane がジャンプする。

## AnalysisContext API

### 入力 ($state、外部から書き換え可能)

| フィールド | 型 | 用途 |
|---|---|---|
| `howlText` | `string` | `.howl` 文字列。EditorPane が双方向 bind |
| `cursorLine` | `number` | 現在のカーソル行。parse の `cursorLine` オプションに渡る (途中までの解析) |
| `assumptions` | `Map<number, SystemRole>` | 役職仮定 (Retar への入力) |
| `hocusPocusSeats` | `Set<number>` | 狐の可能性のみを試す席集合 |
| `denyWolfGroups` | `number[][]` | 「狼ではない」と仮定する席のグループ |
| `forceTs` | `boolean` | retar-rs を無効化して TS 版を使う |

### 派生 ($derived、読み取り専用)

`meta` / `statements` / `fullStatements` / `parsedLines` / `statementLines` / `villageStatus` / `players` / `playerShortNames` / `setup` / `sourceLines` / `currentEvents` / `dict` / `analysisColumns`

### 解析結果 ($state、worker から書き込み)

`analysisSeats` / `baseAnalysisSeats` / `analysisError` / `analyzing` / `analysisDuration` / `analysisStats` / `gmorkResult` / `wolfPairSuggestions`

### イベントバス

- `onSeek(listener) → unsub` / `emitSeek(ev)` — EditorPane の時刻ボタン → 動画 player への seek 要求
- `onJump(listener) → unsub` / `jumpTo(ev)` — ペインの行クリック → EditorPane のカーソル移動要求

host (consumer) 側でこれらを購読し、自前の動画 player / editor 操作と接続する。

### Lifecycle

- `constructor()` — `$effect.root` 内で「解析リクエスト」「gmork 計算」の `$effect` を起動
- `destroy()` — root effect を破棄、listener を全 clear

必ず `onDestroy(() => ctx.destroy())` で後始末すること。

## ディレクトリ構成

```
src/lykaon/
  index.ts                   ← public API (このパッケージのエントリ)
  AnalysisContext.svelte.ts  ← 共有 state ($state + $derived)
  runAnalysis.ts             ← worker dispatcher
  analysis.worker.ts         ← Web Worker 本体 (retar 実行)
  scheduler.ts               ← worker 同期キューイング
  stringify.ts               ← howl → 日本語要約
  theme.css                  ← カラートークン (Catppuccin ベース)
  panes/                     ← 5 ペイン
  status/                    ← StatusPane の sub-component
  editor/                    ← CodeMirror language / completion / theme
```

## 開発ステータス

- ✅ Phase 1-6: lykaon 単体として完成、`horkew/lykaon` として公開済み
- 🚧 Phase 7: 同リポジトリの `demo/` を lykaon ベースに刷新中 (Stage A 完了、B/C/D 進行予定)

## 関連ドキュメント

- [tasks/lykaon-extraction.md](../../tasks/lykaon-extraction.md) — 抽出計画書 + 進捗ログ
- [tasks/lykaon-handoff.md](../../tasks/lykaon-handoff.md) — Phase 7 のハンドオフ
