# Lupa Engine 仕様書

Lupa は人狼ゲームの**純粋なゲームエンジン**。ルール実行と状態管理だけを担い、全ての意思決定を外部のハンドラーに委譲する。

---

## 設計原則

| 原則 | 内容 |
|------|------|
| **ルール実行のみ** | 夜解決、投票解決、処刑、勝利判定、イベント記録 |
| **意思決定ゼロ** | 誰を占うか、誰に投票するか — 全て GameHandlers コールバック経由 |
| **状態の透明性** | GameState が唯一の真実。closure 変数や隠れた状態を持たない |
| **消費者非依存** | Lupa は fenrir, CLI, テスト等の消費者を一切知らない |

### 境界ルール

| ルール | 理由 |
|--------|------|
| Lupa は `ext` の中身を知らない | structuredClone で複製するだけ |
| Lupa は戦略を import しない | 意思決定は GameHandlers 経由で注入 |
| Lupa はキャッシュを持たない | 派生データの管理は消費者の責務 |
| Lupa は学習の概念を知らない | trajectory, 報酬, 勾配は消費者の世界 |

---

## アーキテクチャ

```
┌─────────────────────────────────────────┐
│  Consumer (fenrir, CLI, test 等)        │
│                                         │
│  GameHandlers を実装して注入             │
│  ext の型と初期値を定義                   │
│  意思決定の全責任を負う                    │
├─────────────────────────────────────────┤
│  Lupa Engine                            │
│                                         │
│  - GameState<Ext> の生成・更新・複製      │
│  - フェーズ進行 (night → day → vote)     │
│  - 夜解決 (呪殺、護衛、襲撃、猫又道連れ)  │
│  - 投票解決 (再投票、タイブレーク)         │
│  - 処刑 (猫又道連れ、背徳者後追い)        │
│  - 勝利判定                              │
│  - イベント記録                           │
│  - スナップショット取得・復元              │
└─────────────────────────────────────────┘
```

依存方向は **Consumer → Lupa** の一方向のみ。Lupa は Consumer を知らない。

---

## GameState\<Ext\>

ゲームの全状態を保持する単一のデータ構造。

```typescript
type GameState<Ext = unknown> = {
  // --- Lupa が管理するゲーム事実 ---
  players: PlayerState[]
  day: number
  phase: 'night' | 'day'
  finished: boolean
  result: 'villager_won' | 'werewolf_won' | 'werehamster_won' | 'draw' | null
  executionHistory: Map<number, number>   // day → seat
  commander: number | null
  masonPartners?: Map<number, number>     // seat → partnerSeat

  // --- Consumer 定義の拡張スロット ---
  ext: Ext
}
```

### Ext の契約

| 項目 | 内容 |
|------|------|
| Lupa は ext の中身に**一切触らない** | 型パラメータとして受け取り、structuredClone で複製するだけ |
| 初期化は Consumer の責務 | `onSetup` ハンドラー内で `state.ext = { ... }` として設定する |
| snapshot に自動で含まれる | `structuredClone(state)` が ext も含めて深いコピーを作る |
| resumeGame で自動復元 | snapshot から state を復元すれば ext もそのまま戻る |

### Ext に適したデータ

| 分類 | 例 | 理由 |
|------|-----|------|
| Consumer 固有の進行状態 | 処刑プランのキャッシュ、議論の履歴 | ゲーム事実ではないが、snapshot で保存・復元が必要 |
| 派生データのキャッシュ | 推理結果、詰み判定 | 再計算可能だがコストが高い。snapshot に含めると resume 後に即利用可能 |

### Ext に不適なデータ

| 分類 | 適切な置き場所 | 理由 |
|------|---------------|------|
| ゲーム事実 (players, day 等) | GameState 本体 | Lupa のルールで更新される |
| Consumer 内部状態 (NN重み, trajectory) | Consumer 自身 | ゲーム状態ではない。snapshot 対象外 |
| 一時データ (ループ変数, 1フェーズ内の集計) | 関数スコープ | 関数が終われば消える |

### structuredClone 前提

Ext に格納するデータは `structuredClone` で複製可能でなければならない:
- OK: プレーンオブジェクト, 配列, Map, Set, TypedArray, プリミティブ
- NG: 関数, クラスインスタンス (メソッドが消失), Symbol, DOM ノード

---

## GameHandlers

Consumer が実装し、エンジンに注入するコールバック群。

```typescript
type GameHandlers<E = never, Ext = unknown> = {
  onSetup?(roles, state): MaybePromise<void>
  onNight(ctx): MaybePromise<Map<number, NightAction>>
  onDayClaims(ctx): MaybePromise<Map<number, DayClaim>>
  onPreVote?(ctx): MaybePromise<PreVoteResult<E>>
  onLastWill?(ctx, executedSeat): MaybePromise<DayClaim>
  onVote(ctx): MaybePromise<Map<number, number>>
  onEvent?(event): void
  getTiming?(): GameTiming
  getTsumiCache?(): Map<number, boolean>
}
```

### ハンドラーのライフサイクル

```
runGame(config, handlers)
  │
  ├─ 役職割当
  ├─ onSetup(seatRoles, state)     ← ext 初期化のタイミング
  │
  ├─ Night 0
  │   └─ onNight(ctx)              ← 初夜の行動 (占い先等)
  │
  └─ Day 1 〜 Day N (メインループ)
      │
      ├─ Night (Day 2+)
      │   └─ onNight(ctx)          ← 夜行動
      │   └─ [夜解決: 呪殺→護衛→襲撃→猫又道連れ→背徳者後追い]
      │   └─ [勝利判定]
      │
      ├─ Day
      │   ├─ onDayClaims(ctx)      ← CO・結果報告
      │   ├─ [強制対抗CO]
      │   ├─ onPreVote?(ctx)       ← 議論・指揮者・予告 (オプション)
      │   │
      │   ├─ Vote (再投票ループ)
      │   │   └─ onVote(ctx)       ← 投票先
      │   │
      │   ├─ onLastWill?(ctx)      ← 遺言CO (オプション)
      │   └─ [処刑→猫又道連れ→背徳者後追い→勝利判定]
      │
      └─ [スナップショット取得 (設定時)]
```

### 各ハンドラーの責務

#### onSetup (オプション)

```typescript
onSetup?(roles: Map<number, SystemRole>, state: GameState<Ext>): MaybePromise<void>
```

役職割当後、ゲーム開始前に呼ばれる。**mutable な state** を受け取る。

主な用途:
- `state.ext` の初期化
- 役職に応じた戦略の割当
- 秘密知識 (PlayerView) の事前構築

#### onNight (必須)

```typescript
onNight(ctx: PhaseContext<E, Ext>): MaybePromise<Map<number, NightAction>>
```

夜行動を持つプレイヤーのアクションを返す。

- 占い師: `{ type: 'divine', target }` — 対象の占い結果をエンジンが記録
- 狩人: `{ type: 'guard', target }` — 護衛先をエンジンが記録
- 人狼: `{ type: 'attack', target }` — 襲撃先
- その他: `{ type: 'none' }` — 行動なし

#### onDayClaims (必須)

```typescript
onDayClaims(ctx: PhaseContext<E, Ext>): MaybePromise<Map<number, DayClaim>>
```

各プレイヤーの CO・結果報告を返す。

#### onPreVote (オプション)

```typescript
onPreVote?(ctx: PhaseContext<E, Ext>): MaybePromise<PreVoteResult<E>>
```

投票前の議論フェーズ。未提供の場合、CO の直後に投票に進む。

戻り値:
- `additionalClaims`: 議論中に追加された CO
- `events`: 議論フェーズで発生したカスタムイベント

#### onVote (必須)

```typescript
onVote(ctx: VoteContext<E, Ext>): MaybePromise<Map<number, number>>
```

各プレイヤーの投票先を返す。再投票時にも呼ばれる。

VoteContext の追加情報:
- `revoteRound`: 再投票ラウンド (0 = 初回)
- `candidates`: 再投票候補 (null = 全員が対象)

#### onLastWill (オプション)

```typescript
onLastWill?(ctx: PhaseContext<E, Ext>, executedSeat: number): MaybePromise<DayClaim>
```

処刑対象者が最後に CO する機会。`rules['phase.lastwill']` が true の場合のみ呼ばれる。

#### onEvent (オプション)

```typescript
onEvent?(event: GameEvent | E): void
```

イベント発生時の通知コールバック。観測・ログ用。

---

## PhaseContext / VoteContext

エンジンからハンドラーに渡す読み取り専用のコンテキスト。

```typescript
type PhaseContext<E = never, Ext = unknown> = {
  day: number
  state: Readonly<GameState<Ext>>
  events: readonly (GameEvent | E)[]
  alivePlayers: number[]              // 生存者の seat 一覧
  rules: ResolvedRules
}

type VoteContext<E = never, Ext = unknown> = PhaseContext<E, Ext> & {
  revoteRound: number
  candidates: number[] | null
}
```

### state の Readonly について

`PhaseContext.state` は `Readonly<GameState<Ext>>` だが、**浅い Readonly** である。
`state.ext` の中身は Consumer が自由に読み書きしてよい（参照渡し）。
エンジンが state を更新するのはハンドラー呼び出しの間（夜解決、処刑等）のみ。

---

## カスタムイベント型パラメータ \<E\>

GameHandlers, PhaseContext, GameResult 等のジェネリックパラメータ `E` を使うと、Consumer 独自のイベント型を GameEvent に合流させられる。

```typescript
// Consumer 定義のカスタムイベント
type MyEvent =
  | { type: 'signal', from: number, content: string }
  | { type: 'proposal', from: number, plan: number[] }

// E=MyEvent で型付け
const handlers: GameHandlers<MyEvent, MyExt> = {
  onPreVote(ctx) {
    return {
      events: [
        { type: 'signal', from: 1, content: '...' },  // 型安全
      ]
    }
  },
  // ...
}
```

カスタムイベントはエンジンの `events` 配列に記録され、`onEvent` で通知され、snapshot にも含まれる。エンジンはカスタムイベントの中身を解釈しない。

---

## スナップショットと resumeGame

### スナップショット取得

`GameConfig.captureSnapshotDays` に指定した Day の処刑後にスナップショットを取得する。

```typescript
type GameSnapshot<E = never, Ext = unknown> = {
  state: GameState<Ext>     // ext 含む深いコピー
  events: (GameEvent | E)[] // ここまでの全イベント
  rngState: number          // 乱数状態
  config: GameConfig
  seatRoles: Map<number, SystemRole>
}
```

### resumeGame

スナップショットからゲームを再開する。

```typescript
async function resumeGame<E, Ext>(
  snapshot: GameSnapshot<E, Ext>,
  handlers: GameHandlers<E, Ext>,
): Promise<GameResult<E, Ext>>
```

動作:
1. `structuredClone(snapshot.state)` で state を復元 — **ext も自動復元**
2. `onSetup(seatRoles, state)` を呼ぶ — Consumer が戦略を再初期化
3. `snapshot.state.day + 1` の Night からメインループを開始

**Consumer の closure 状態は復元されない。** 永続データを全て `state.ext` に格納しておけば、snapshot/resume で完全に復元できる。これが ext の最も重要な設計動機。

---

## 投票解決

### フロー

```
初回投票 (onVote)
  │
  ├─ 決着 → 処刑
  └─ 同数
      │
      ├─ random_tied: エンジンが候補者限定ランダム投票を解決 (onVote を呼ばない)
      └─ full_revote: onVote を再度呼ぶ (candidates に候補者を渡す)
          │
          └─ maxRevotes 超過 → tiebreaker
              ├─ lowest_seat: 最小 seat を処刑
              └─ draw: 引き分け終了
```

### RevoteConfig

```typescript
type RevoteConfig = {
  maxRevotes: number                          // デフォルト: 3
  style: 'random_tied' | 'full_revote'        // デフォルト: 'random_tied'
  tiebreaker: 'lowest_seat' | 'draw'          // デフォルト: 'lowest_seat'
}
```

### 自投票禁止

エンジンは自分自身への投票を自動的にランダムな他プレイヤーに変更する。Consumer は自投票を返してもよいが、適用されない。

---

## 夜解決の順序

```
1. 占い結果の記録 (divineHistory)
2. 護衛先の記録 (guardHistory)
3. 占い呪殺チェック: 占い対象が妖狐 → 死亡 → 背徳者後追い
4. 護衛判定: 襲撃対象 = 護衛先 → 襲撃失敗
5. 襲撃処理:
   - 妖狐: 死なない
   - 猫又: 猫又死亡 + 襲撃した人狼を道連れ
   - 通常: 死亡
6. 平和判定: 死者なし → peace イベント
```

---

## 勝利判定

以下のタイミングで判定:
- 夜解決後
- 処刑 + 猫又道連れ + 背徳者後追い後

判定ロジック:
- **人狼全滅** → 妖狐生存なら狐勝ち、さもなくば村勝ち
- **人狼 >= 非狼非狐の生存者数** → 妖狐生存なら狐勝ち、さもなくば狼勝ち
- 妖狐は人数カウントから除外される

---

## 強制対抗CO

CO済みの役職に対して、真役職者が未COなら**エンジンが自動的に強制CO**する。

対象役職: 占い師, 霊媒師, 狩人, 共有者, 猫又

これはゲームルールの実装であり、Consumer の意思決定ではない。

---

## PlayerView

役職に応じた秘密知識を構築するユーティリティ (`player-view.ts`)。

```typescript
type PlayerView = {
  wolfTeammates: number[] | null    // 人狼 → 他の人狼
  knownWolves: number[] | null      // 狂信者 → 人狼一覧
  knownHamster: number | null       // 背徳者 → 妖狐
  masonPartner: number | null       // 共有者 → 相方
}
```

`buildPlayerView(state, seat)` で取得。Consumer が DecisionContext を構築する際に使う。

---

## 乱数

Mulberry32 ベースの決定的 PRNG (`random.ts`)。

- `new Rng(seed)` でシード初期化
- `rng.getState()` / `Rng.fromState(state)` で状態の保存・復元
- スナップショットに `rngState` として含まれ、resumeGame で復元

---

## 公開 API

### runGame

```typescript
async function runGame<E = never, Ext = unknown>(
  config: GameConfig,
  handlers: GameHandlers<E, Ext>,
): Promise<GameResult<E, Ext>>
```

新規ゲームを最初から実行する。

### resumeGame

```typescript
async function resumeGame<E = never, Ext = unknown>(
  snapshot: GameSnapshot<E, Ext>,
  handlers: GameHandlers<E, Ext>,
): Promise<GameResult<E, Ext>>
```

スナップショットからゲームを再開する。

### GameResult

```typescript
type GameResult<E = never, Ext = unknown> = {
  events: (GameEvent | E)[]
  state: GameState<Ext>
  config: GameConfig
  timing?: GameTiming
  snapshots?: Map<number, GameSnapshot<E, Ext>>
}
```
