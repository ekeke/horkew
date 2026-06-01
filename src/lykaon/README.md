# lykaon — howl エディタ / 解析 UI ライブラリ

Horkew の `.howl` 形式ログを編集するための **CodeMirror ベース専用エディタ** に、
役職推理 (retar) / 詰み探索 (hati) を可視化する optional な解析ペインを
組み合わせる Svelte 5 + Vite 製の UI モジュール。

`createAnalysisContext()` で共有 state を作り、`EditorPane` 単体でも動かせるし、
解析サイドカーを横に並べれば編集に追随して結果が更新される。

## 設計の中心

- **EditorPane が core** — `.howl` 専用シンタックスハイライト、補完、player 名解決、時刻ボタンを
  備えた CodeMirror 6 エディタ。これだけでスタンドアローンの `.howl` エディタとして動く。
- **解析ペインは optional** — `StatusPane` / `AnalysisTable` / `HatiPane` を必要なだけ並べる。
  EditorPane の編集が即座に反映される。
- **debug / 専用ツール** — `InspectPane` (fenrir/skoll の game ログ閲覧) は用途が限定的で、
  default では並べないことを推奨。

## 前提

- **Vite 専用**: `?worker` / `?url` import 構文を使うため、 consumer 側も Vite ビルド必須
- **Svelte 5**: runes (`$state` / `$derived` / `$effect`) を要求
- **TypeScript**: ソースコードを直接 export (pre-built bundle は提供しない)

## 最小構成: エディタだけ

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { createAnalysisContext, EditorPane } from 'horkew/lykaon'
  import 'horkew/lykaon/theme.css'

  const ctx = createAnalysisContext()
  onDestroy(() => ctx.destroy())
</script>

<EditorPane {ctx} />
```

これだけで `.howl` のシンタックスハイライト・補完・時刻ボタンが効くエディタが動く。
`ctx.howlText` に文字列を代入すれば初期値を流し込める。

サンプル: [demo/PlainLykaonPane.svelte](../../demo/PlainLykaonPane.svelte) — siren3 シナリオを
読み込んで EditorPane + StatusPane + AnalysisTable を並べた最小構成。
`/horkew/plain.html` から閲覧可能。

## 解析ペインを足す

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    createAnalysisContext,
    EditorPane, StatusPane, AnalysisTable, HatiPane,
  } from 'horkew/lykaon'
  import 'horkew/lykaon/theme.css'

  const ctx = createAnalysisContext()
  onDestroy(() => ctx.destroy())
</script>

<div class="layout">
  <EditorPane {ctx} />
  <div class="side">
    <StatusPane {ctx} />
    <AnalysisTable {ctx} />
    <HatiPane {ctx} />
  </div>
</div>
```

EditorPane で `.howl` を編集すると Web Worker 経由で Retar が走り、 `StatusPane` /
`AnalysisTable` / `HatiPane` の表示が即時更新される。 ペイン → 行クリックで EditorPane が
ジャンプする (`ctx.onJump` 経由)。

## エクスポート

| 名前 | 役割 |
|---|---|
| `createAnalysisContext(options?)` | `AnalysisContext` インスタンスを作る factory |
| `AnalysisContext` | 共有 state クラス (class 直接利用も可) |
| `EditorPane` | `.howl` 専用 CodeMirror エディタ (core) |
| `StatusPane` | 生存者・投票・襲撃・カミングアウト・死亡履歴の集約表示 |
| `AnalysisTable` | 役職可能性 × 席 のテーブル + 仮説サイドバー |
| `HatiPane` | 詰み探索結果 |
| `InspectPane` | fenrir/skoll の game ログ閲覧 (時系列・retar スナップショット) |

型: `AnalysisContextOptions` / `HowlPreprocessor` / `SeekEvent` / `JumpEvent` /
`SourceLines` / `SeatResult` / `AnalysisStats` / `WolfPairSuggestion` / `StringifiedLine`

### createAnalysisContext のオプション

```ts
createAnalysisContext({
  preprocess: (text) => text.replace(/^@@hello$/m, '吾輩 → ネコ'),
})
```

| オプション | 型 | 用途 |
|---|---|---|
| `preprocess` | `(text: string) => string` | editor のテキストを parse 直前に変換するフック。返した文字列が howl parser への入力になる。 editor 表示自体は変えない (双方向 bind は `howlText` のまま)。マクロ展開・テンプレ注入などに使う。 例外を投げた場合は元の text にフォールバック (safeParse と同じ方針) |

## AnalysisContext API

### 入力 ($state、外部から書き換え可能)

| フィールド | 型 | 用途 |
|---|---|---|
| `howlText` | `string` | `.howl` 文字列。 EditorPane が双方向 bind |
| `cursorLine` | `number` | 現在のカーソル行。 parse の `cursorLine` オプションに渡る |
| `assumptions` | `Map<number, SystemRole>` | 役職仮定 (Retar への入力) |
| `hocusPocusSeats` | `Set<number>` | この席の CO を無視して解析する集合 |
| `denyWolfGroups` | `number[][]` | 「両狼ではない」と仮定する席ペア |
| `forceTs` | `boolean` | retar-rs を無効化して TS 版を使う (debug 用) |

### 派生 ($derived、読み取り専用)

- パース/状態: `meta` / `statements` / `fullStatements` / `parsedLines` / `statementLines` /
  `villageStatus` / `players` / `playerShortNames` / `setup` / `sourceLines` / `currentEvents` /
  `dict` / `analysisColumns`
- 死亡カテゴリ: `deadSeats` / `nightKilledSeats` / `executedSeats` / `claimShortNames`
- 解析完了判定: `allRolesDetermined`

### 解析結果 ($state、worker から書き込まれる)

`analysisSeats` / `baseAnalysisSeats` / `analysisError` / `analyzing` / `analysisDuration` /
`analysisStats` / `wolfPairSuggestions`

### 仮説操作メソッド

| メソッド | 動作 |
|---|---|
| `toggleAssumption(seat, role)` | 役職仮定をトグル (同じならクリア、別役職なら上書き) |
| `toggleHocusPocus(seat)` | hocuspocus フラグをトグル |
| `clearAssumptions()` | assumptions / denyWolfGroups / hocusPocusSeats を全消去 |
| `removeDenyWolfGroup(i)` | denyWolfGroups の i 番目を削除 |
| `addSuggestion(suggestion)` | wolfPairSuggestions の 1 件を denyWolfGroups に昇格 |

`ctx.assumptions = new Map(...)` のような直接代入でも worker 再解析は発火するが、 メソッド経由が
recommended。

### イベントバス

| メソッド | 用途 |
|---|---|
| `onSeek(listener) → unsub` / `emitSeek(ev)` | EditorPane の時刻ボタン → 動画 player への seek |
| `onJump(listener) → unsub` / `jumpTo(ev)` | ペイン行クリック → EditorPane のカーソル移動 |
| `onCursorChange(listener) → unsub` / `emitCursorChange(line)` | EditorPane の物理カーソル移動のみ通知 (`ctx.cursorLine = X` の単純代入では発火しない) |
| `onExternalLoad(listener) → unsub` / `loadHowl(text)` | InspectPane 等から howl を読み込んだ通知 (consumer は trial mode 等の副作用に使う) |

host (consumer) 側でこれらを購読し、自前の動画 player / editor 操作 / モード切替と接続する。

### Lifecycle

- `constructor()` — `$effect.root` 内で「解析リクエスト」の `$effect` を起動
- `destroy()` — root effect を破棄、 listener を全 clear

必ず `onDestroy(() => ctx.destroy())` で後始末すること。

## AnalysisTable の prop

```svelte
<AnalysisTable
  {ctx}
  onInsertRevealRoles={() => { ... }}      <!-- 配役確定時の挿入ボタン (省略時は非表示) -->
  onOpenDenyWolfDialog={() => { ... }}     <!-- 仮説追加ボタン (省略時は非表示) -->
  extraFooter={mySnippet}                  <!-- table 下部に追加 UI を差し込む snippet -->
/>
```

debug / dialog UI は consumer 側で実装し、 callback として渡す設計。 何も渡さなければ
「素朴な解析テーブル + 仮説リスト」だけが表示される。

## EditorPane の prop

```svelte
<EditorPane
  {ctx}
  readonly={false}                <!-- 編集ロック -->
  extraExtensions={myExtensions}  <!-- CodeMirror Extension を追加 (動画連動など consumer 固有機能) -->
/>
```

## ディレクトリ構成

```
src/lykaon/
  index.ts                   ← public API
  AnalysisContext.svelte.ts  ← 共有 state ($state + $derived + メソッド)
  runAnalysis.ts             ← worker dispatcher
  analysis.worker.ts         ← Web Worker 本体 (retar 実行)
  scheduler.ts               ← worker 同期キューイング
  stringify.ts               ← howl → 日本語要約
  theme.css                  ← カラートークン (Catppuccin ベース)
  panes/                     ← EditorPane / StatusPane / AnalysisTable /
                                HatiPane / InspectPane
  status/                    ← StatusPane / AnalysisTable の sub-component
                                (PlayerName / SpeciesIcon / SummaryTable / 等)
  editor/                    ← CodeMirror language / completion / theme
```

## 開発ステータス

- ✅ **Phase 1-7 完了 (第一次 Lykaon プロジェクト)** — `horkew/lykaon` として公開済み、
  demo は lykaon を consume する薄い shell に再構築済み
- 旧 `demo/HatiPane.svelte` / `demo/InspectPane.svelte` / `demo/GmorkDebugPane.svelte` は削除済み
- `demo/status/` のみ overlay 専用として一時的に温存 (将来の Overlay 側 lykaon 化で削除予定)
