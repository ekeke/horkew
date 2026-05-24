# demo/ コーディング規約

## 技術スタック

- **Svelte 5** — runes (`$state`, `$derived`, `$props`, `$effect`)
- **Vite** — ビルド / dev server
- **TypeScript** — `lang="ts"` 必須
- **セミコロンなし**（プロジェクト全体の規約に準拠）

## コンポーネント設計

### Props パターン
```svelte
<script lang="ts">
  let { propA, propB }: { propA: string, propB: number } = $props()
</script>
```
- 型定義はインラインで `$props()` の左辺に書く
- interface を別途定義しない（props が 5 つ以下の場合）

### スコープドスタイル
- すべてのスタイルは `<style>` ブロック内にスコープする
- `:global()` は `App.svelte` のリセットスタイルのみ許可
- 他コンポーネントでの `:global()` 使用は原則禁止

### ファイル構成
```
demo/
├── App.svelte             # メインレイアウト、ペインシステム
├── main.ts                # main entry (index.html)
├── Overlay.svelte         # OBS 用オーバーレイ
├── overlay.ts             # overlay entry (overlay.html)
├── PlainLykaonPane.svelte # 裸の lykaon 確認画面
├── plain.ts               # plain entry (plain.html)
├── FileSidebar.svelte     # ファイル一覧サイドバー
├── HelpPanel.svelte       # ヘルプパネル
├── ColorSwatchPane.svelte # 色見本（devMode 用）
├── SkollPane / PretrainPane / StatsPane / CommandPlayPane / NicoPlayer / YouTubePlayer  # demo 固有
├── status/                # Overlay 専用の status 部品群 (lykaon 化前の旧版を温存)
└── (lykaon 由来の EditorPane / StatusPane / HatiPane / AnalysisTable は src/lykaon から import)
```

### Entry points (vite.config.ts の rollupOptions.input)

| URL | entry | 用途 |
|---|---|---|
| `/horkew/` | `main.ts` → `App.svelte` | メイン UI (FileSidebar + 全ペイン + 動画連動) |
| `/horkew/overlay.html` | `overlay.ts` → `Overlay.svelte` | OBS / BroadcastChannel 連携の配信用オーバーレイ |
| `/horkew/plain.html` | `plain.ts` → `PlainLykaonPane.svelte` | 拡張なしの裸 lykaon 動作確認用 (EditorPane + StatusPane + AnalysisTable) |

### lykaon との関係

demo は `src/lykaon/` を consume する薄い shell。 エディタ・StatusPane・AnalysisTable・HatiPane などの解析 UI は lykaon に集約されており、 demo はそれらに動画 player・FileSidebar・Skoll/Pretrain/Stats/CommandPlay 等の demo 固有機能をかぶせるだけ。 新規 UI 機能を足すときは「lykaon に入れるべきか demo に入れるべきか」を最初に判断する (mirurou など外部 consumer で再利用したいなら lykaon)。

## スタイリングルール

### カラー
- **hex 値の直接ハードコード禁止** — 必ず CSS 変数を使う
- カラー定義は `theme.css` を参照。パレット色 (`--ctp-*`) とセマンティックトークン (`--color-*`) の2層構造
- コンポーネント内では **セマンティックトークン** (`--color-*`) を優先的に使う
- 該当するセマンティックトークンがない場合のみパレット色 (`--ctp-*`) を直接参照してよい
- 新しい用途の色が必要な場合は `theme.css` にセマンティックトークンを追加する
- devMode の Color Swatch ペインで全トークンを確認できる

### フォント
- UI テキスト: `system-ui, -apple-system, sans-serif`
- コード / モノスペース: `'Consolas', 'Menlo', monospace`

### レイアウト
- Flexbox ベース
- `rem` / `px` 混在可（既存コードに合わせる）

## devMode / debugMode

### devMode
- タイトルを 3 秒以内に 7 回タップでトグル
- `localStorage` に保存される
- skin 切り替え、debug ボタンが表示される

### debugMode
- devMode 有効時のみ利用可能
- 全ペインを個別に表示/非表示にできる Panes メニューが表示される
- 通常レイアウト（prod）ではなく、全ペイン横並びレイアウトに切り替わる

## ペインの追加方法

1. `paneEntries` 配列にエントリを追加: `{ id: 'myPane', label: 'My Pane' }`
2. `defaultPanes` に初期値を追加: `myPane: true`
3. コンポーネントを作成（props は必要に応じて）
4. `{#if debugMode}` ブロック内に `{#if paneVisible.myPane}` で追加
5. 型は `PaneId` として自動推論される（`as const` による）
