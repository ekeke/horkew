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

## ペインをまとめて並べる: `LykaonLayout`

エディタ + 解析サイドカーの「とりあえずの標準構成」を 1 行で立ち上げる結合レイアウト:

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { createAnalysisContext, LykaonLayout } from 'horkew/lykaon'
  import 'horkew/lykaon/theme.css'

  const ctx = createAnalysisContext()
  onDestroy(() => ctx.destroy())
</script>

<LykaonLayout {ctx} />
```

| prop | 型 / default | 用途 |
|---|---|---|
| `ctx` | `AnalysisContext` | 必須 |
| `ratio` | `[number, number]` / `[1, 2]` | 左 (エディタ) : 右 (StatusPane + AnalysisTable) の flex 比率。 main demo に合わせて 1:2 |
| `maxEditorPx` | `number` / `400` | エディタ側の最大幅 (px)。 0 で無制限 |
| `hideAssumptions` | `boolean` / `false` | AnalysisTable の右サイドバー (仮説 / 提案) を非表示にする (配役確定バナーは残る) |
| `readonly` | `boolean` / `false` | 内蔵 EditorPane の編集ロック (EditorPane の `readonly` prop に流す) |

レイアウト・ペイン構成を自由に組みたい consumer は、 `LykaonLayout` を使わず個別ペインを
直接マウントする (下記 §解析ペインを足す)。

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
| `LykaonLayout` | エディタ + 解析サイドカーの結合レイアウト (1:2 比率がデフォルト)。 ctx を渡すだけで標準構成が立ち上がる |
| `EditorPane` | `.howl` 専用 CodeMirror エディタ (core) |
| `StatusPane` | 生存者・投票・襲撃・カミングアウト・死亡履歴の集約表示 |
| `VerticalStatusPane` | 狭幅カラム用の縦長 StatusPane。 タブで集約/投票を切り替え、 役職セクションごとにリスト表示 |
| `AnalysisTable` | 役職可能性 × 席 のテーブル + 仮説サイドバー |
| `HatiPane` | 詰み探索結果 |
| `InspectPane` | fenrir/skoll の game ログ閲覧 (時系列・retar スナップショット) |

型: `AnalysisContextOptions` / `HowlPreprocessor` / `PreprocessResult` / `SeekEvent` / `JumpEvent` /
`SourceLines` / `SeatResult` / `AnalysisStats` / `WolfPairSuggestion` / `StringifiedLine`

### createAnalysisContext のオプション

```ts
createAnalysisContext({
  preprocess: (text) => text.replace(/^@@hello$/m, '吾輩 → ネコ'),
})
```

| オプション | 型 | 用途 |
|---|---|---|
| `preprocess` | `(text: string) => string \| PreprocessResult` | editor のテキストを parse 直前に変換するフック。返した文字列が howl parser への入力になる。 editor 表示自体は変えない (双方向 bind は `howlText` のまま)。マクロ展開・テンプレ注入などに使う。 例外を投げた場合は元の text にフォールバック (safeParse と同じ方針) |

prepend など行数が変わる変換 (例: 解析用に setup/JOIN を K 行ぶん前置) を入れる場合は string ではなく
`PreprocessResult = { text, lineOffset }` を返すこと。 `lineOffset` に前置した行数 K を入れると、
`AnalysisContext` が cursor を parse 入力へ渡すとき +K、 statement.line / `sourceLines` を editor へ
公開するときに -K してエディタ座標と parse 座標のズレを吸収する。 string 戻りは従来どおり `lineOffset: 0`
扱い (後方互換)。

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
| `insertRevealRoles()` | 配役確定時に `Player=役職名` 行を howlText に書き込む。 既存 reveal 行があれば置換、無ければ末尾追加 (未確定なら no-op) |

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
  onInsertRevealRoles={(done) => { ...; done() }}  <!-- 配役確定時の挿入動作を上書き。実行中は挿入ボタンが disable、 done() で解除。省略時は ctx.insertRevealRoles() -->
  onOpenDenyWolfDialog={() => { ... }}     <!-- 仮説追加ボタン (省略時は非表示) -->
  extraFooter={mySnippet}                  <!-- table 下部に追加 UI を差し込む snippet -->
  determinedBanner={myBannerSnippet}       <!-- 配役確定バナーの UI 全体を差し替える snippet ({ insert, busy } を受け取る) -->
  hideAssumptions={true}                   <!-- 右サイドバー (仮説 / 提案) を非表示。配役確定バナーは残る -->
/>
```

配役確定時の「挿入」ボタンは `ctx.allRolesDetermined` が true になると **テーブル直下**
に常に表示され、 default では `ctx.insertRevealRoles()` を呼んで `Player=役職名` 行を書き込む
(既存 reveal 行があれば置換、無ければ末尾追加)。 format を変えたい consumer は `onInsertRevealRoles` callback を渡して上書き
できる。 callback は `done` 関数を引数で受け取り、 hook 実行中は挿入ボタンが disable になる。
consumer は処理完了時に `done()` を呼んで disable を解除する (例: 保存完了後に解除)。
`hideAssumptions` を true にしてもこのバナーは残るので、 「サイドバーは出さない
が配役確定の挿入だけは使いたい」用途に対応する。

バナーの **見た目自体** を差し替えたい場合は `determinedBanner` snippet を渡す。
発火条件は default と同じく `ctx.allRolesDetermined` が true のときだけ。 snippet は
`{ insert, busy }` を受け取り、 `insert()` を呼べば `onInsertRevealRoles` (無ければ
`ctx.insertRevealRoles()`) が起動し、 `busy` で実行中の disable 表現ができる:

```svelte
{#snippet myBannerSnippet({ insert, busy })}
  <div class="my-custom-banner">
    <button onclick={insert} disabled={busy}>独自の挿入ボタン</button>
  </div>
{/snippet}
```

仮説追加 (`onOpenDenyWolfDialog`) や `extraFooter` 等の debug / dialog UI は consumer 側で
実装する設計。 何も渡さなければ「素朴な解析テーブル + 仮説リスト + 配役確定ボタン」が表示される。

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
  theme.css                  ← カラートークン (Catppuccin ベース) + reset.css の import
  reset.css                  ← 埋め込み防御基底 (.lyk-pane 名前空間)
  panes/                     ← EditorPane / StatusPane / AnalysisTable /
                                HatiPane / InspectPane
  status/                    ← StatusPane / AnalysisTable の sub-component
                                (PlayerName / SpeciesIcon / SummaryTable / 等)
  editor/                    ← CodeMirror language / completion / theme
```

## 埋め込み防御 (host CSS 流入の遮断)

別 host アプリ (例: mirurou) に lykaon を埋め込んだとき、 host 側のグローバル CSS
(`* {}`, `table {}`, `button {}`, `body {}` 等のタグセレクタや、 `font-family` /
`font-size` / `line-height` / `color` などの継承プロパティ) が Svelte scoped style
を貫通してペイン内部の表示を壊しうる。 lykaon は CodeMirror 6 と同じ
「名前空間ルート + 継承プロパティ明示」戦略でこれを遮断する (Shadow DOM は使わない)。

### 仕組み

- 各ペインの root 要素に `.lyk-pane` クラスを併記 (`.editor-pane lyk-pane` 等)。
- [reset.css](reset.css) が `.lyk-pane` を起点に継承プロパティを明示上書きし、
  `button` / `table` / `ul` / `pre` 等の tag リセットを適用する
  (`:where(...):not(.cm-editor *)` で specificity 0 + CodeMirror 領域除外)。
- [theme.css](theme.css) が `reset.css` を冒頭で `@import` するので、 consumer は
  従来通り `import 'horkew/lykaon/theme.css'` 1 行だけで両方読まれる。
- Typography トークン `--font-ui` / `--font-mono` を `theme.css` に追加。 配下の
  `font-family` 直書きは廃止し、 全て token 参照へ。
- CodeMirror autocomplete tooltip は `tooltips({ parent })` で `.editor-pane` 配下
  に portal される (default の body 直挿しでは防御の外側になるため)。

**`.lyk-pane` は lykaon 内部用クラス**。 consumer 側で host 要素に付けたり、
独自スタイルを当てたりしないこと。

### 制約

- **`box-sizing` は universal に当てていない** (CodeMirror 内部レイアウト干渉の
  リスクを避けるため)。 ペイン内に新規スタイルを足すときは
  `box-sizing: border-box` を必要に応じて明示すること。
- **InspectPane は `rem` 単位を多用している** ため、 host の `html { font-size }`
  流入は完全には遮断されない。 InspectPane は debug 用途 (fenrir/skoll game ログ閲覧)
  で埋め込み利用は想定していない。
- **`[data-theme]` 属性は lykaon 専用**。 host が独自の `data-theme` システムを
  持つ場合は衝突しうる (将来 `[data-lykaon-theme]` への rename を検討)。

### 検証 entry

`/horkew/hostile.html` (`demo/hostile.html`) で 3 カラム横並びの比較ビューが見られる:

- **baseline**: 敵対 CSS なし — 期待される見た目
- **defended**: 敵対 CSS あり + `.lyk-pane` あり — baseline と一致していれば防御 OK
- **undefended**: 敵対 CSS あり + `.lyk-pane` を mount 後に strip — 防御を外すと
  どこまで崩れるかを示す対照群

敵対 CSS 規則 (`demo/hostile-frame.ts` 内):

```css
* { box-sizing: content-box; }
table { border-collapse: separate; border-spacing: 4px; }
button, input { font-family: "Comic Sans MS"; font-size: 20px; }
body { line-height: 2.4; font-family: serif; text-align: center; color: hotpink; }
ul, ol { list-style: square; padding-left: 40px; }
```

## 開発ステータス

- ✅ **Phase 1-7 完了 (第一次 Lykaon プロジェクト)** — `horkew/lykaon` として公開済み、
  demo は lykaon を consume する薄い shell に再構築済み
- 旧 `demo/HatiPane.svelte` / `demo/InspectPane.svelte` / `demo/GmorkDebugPane.svelte` は削除済み
- `demo/status/` のみ overlay 専用として一時的に温存 (将来の Overlay 側 lykaon 化で削除予定)
