# Hati パフォーマンス記録

## ベンチマーク環境

14d-neko シナリオ (seed=0): 14人村、狼3/村2/占1/霊1/狩1/共2/猫1/信1/狐1/背1

## 最適化の推移

### ベースライン（初期実装）

`Set<Seat>` ベースの alive、`Map<Seat, SystemRole>` ベースの World、文字列メモキー。

| Day | 生存 | ワールド | hati |
|---|---|---|---|
| Day5 | 6人 | 291 | 1ms |
| Day4 | 8人 | 1,104 | 163ms |
| Day3 | 10人 | 数千 | タイムアウト |

### 1. ビットマスク化 + 数値ハッシュ

`alive: Set<Seat>` → `alive: number` ビットマスク。`World.roles: Map` → `SystemRole[]` 配列。`memoKey()` を FNV-1a ハッシュに。夜の観測キーを数値パックに。

Day4: 163ms → **83ms** (2x)

### 2. ベータカット（夜の早期打ち切り）

夜シミュレーション構築中に、あるワールド×噛み先で村が即負けなら `return null`。

Day4: 83ms → **72ms**

### 3. ムーブオーダリング（アルファベータ法）

- OR節点（処刑候補）: 狼確率が高い候補を先に試す
- AND節点（観測分岐）: ワールド数が多い（難しい）分岐を先に試す

Day4: 72ms → **35ms** (2x)

### 4. エンドゲームテーブル

≤6人のポジションを正規形キー（seat番号非依存の役職パターン）でキャッシュ。探索呼び出し間で永続。

- small-8p 100ゲーム: 73エントリ、3,778ヒット
- hati avg: 6.8ms → **3.0ms** (2.3x)

Day2 (9人) が初めて完走: **1,170ms** (12,988ノード、91エントリ、12,051ヒット)

### 5. ワールド縮約 + 占い/護衛候補枝刈り

生存者の役職配置が同一のワールドを統合（死亡者の役職は探索に無関係）。占い候補から情報ゲインのない席を除外。護衛候補から確定狼を除外。両方に等価クラスによる重複排除。

Day2: 12,988ノード → **9,757ノード**、1,170ms → **790ms** (32%)

### 6. 数値エンコード + alloc削減

役職を数値ID化（`World.roleIds: Uint8Array`）し、FNVハッシュの `charCodeAt()` 2回を数値1回に。メモキーの `join(',')` を単一数値畳み込みに。`deduplicateWorlds` の `Set<string>` を `Set<number>` に。`canonicalKey` を数値ソート+パック化。`isConfirmedVillagerInAllWorlds` のSet再生成をモジュールスコープ定数に。`tryNightAction` の `Set<World>` を配列に。`validBiteTargetsMask` でビットマスク直接返却（内側ループの配列alloc除去）。処刑候補の狼カウントを一括計算。

Day2: 790ms → **444ms** (1.8x)
small-8p avg: 3.1ms → **2.4ms** (1.3x)

（3回平均。BEFORE: 870 / 849 / 763ms、AFTER: 410 / 472 / 450ms）

### 7. 狼候補数による枝刈り

全ワールドの `wolfMask` のunionから「人狼の可能性がある生存者数」を算出し、縄数と比較。候補数 > 縄数なら、どの処刑戦略でも全ワールドをカバーできないため即枝刈り。

**縄数 = `floor((alive - 1 - hamster) / 2)`**: 狼命中は縄を消費しない（パリティ±0）、空振りは1縄消費（パリティ-2→処刑1回分）。よってwolfCountに依存せず生存人数のみで決まる。パリティギャップ（`nonWolf - wolfCount`）を縄数として使うと、狼が多い局面で偽の枝刈りが起きるので注意。

- `findTrivialTsumi` + `canPossiblyWin` を `precheckWorlds` に統合（1ループで3判定）
- トップレベル（`index.ts`）でもRetarのpossibilitiesから狼候補を直接取得し、探索前に同チェック

small-8p avg: 2.71ms → **0.04ms** (68x)、max: 63ms → **1.2ms** (53x)
14d-neko Day1-4: タイムアウト/444ms → **0ms**（全チェックポイントで狼候補数により即棄却、ノード0）

### 最終結果

| Day | 生存 | ワールド | ノード | 初期 | 最終 |
|---|---|---|---|---|---|
| Day5 | 6人 | 291 | 1 | 1ms | **0ms** |
| Day4 | 8人 | 1,104 | 1 | 163ms | **0ms** |
| Day3 | 7人 | 264 | 80 | - | **0ms** |
| Day2 | 9人 | 264 | 9,757 | タイムアウト | **0ms** |
| Day1 | 11人 | ? | 7 | タイムアウト | **0ms** |

## 大規模検証結果 (2026-03-26)

25,000ゲーム、66,677チェックポイント、16,661詰み検証で全通過。

| シナリオ | seeds | チェックポイント | 詰み検証 | Hati失敗 | Retar排除 |
|---|---|---|---|---|---|
| small-8p | 5,000 | 11,234 | 3,347 | 0 | 0 |
| medium-10p | 2,000 | 6,578 | 1,998 | 0 | 0 |
| mason-8p | 5,000 | 11,450 | 4,457 | 0 | 0 |
| guard-8p | 5,000 | 12,053 | 4,434 | 0 | 0 |
| nekomata-8p | 3,000 | 6,034 | 1,831 | 0 | 0 |
| 14d-neko | 5,000 | 19,328 | 594 | 0 | 0 |

狐枝刈り偽陰性チェック（14d-neko）: 0件

## 重量ケース

### 14d-neko seed=4244 Day2

CO出そろい後（占い2人が●判定済み）で狼候補が多く分散しているケース。ワールド数が多く、depth=5 まで全探索して「詰みなし」に到達する。

| 項目 | 値 |
|---|---|
| 生存 | 13人 |
| ワールド | 360 |
| ノード | 29,110 |
| 探索時間 | ~1,900ms |
| エンドゲームテーブル | 125エントリ, 15,470ヒット |
| 結果 | 詰みなし |

PNS や反復深化の効果を測る良いベンチマーク。「詰みなし」の証明が最も高コストになるパターン。

## 試みたが不採用

### エンドゲームDB（事前計算テーブル）

4人以下の全ポジションを事前計算してJSONとして埋め込む案。

**不採用理由**: 正規形キーにはワールド集合（役職タプルの組み合わせ）が含まれ、過去の占い結果等の情報状態もワールド集合に反映される。3人×66タプル×最大6ワールドの組み合わせだけで数億通りとなり、Mapの最大サイズを超過。セットアップ制約で絞っても、情報状態の組み合わせ爆発は避けられない。

ランタイムキャッシュ（73エントリで3,778ヒット）が十分に機能しており、事前計算の必要性は低い。

### 8. DFPN (Depth-First Proof Number Search) + 噛み等価クラス (2026-04-01)

`buildStrategy=false` 時の proof-only モードに DFPN を導入。AND-OR木の各レベルで MID (Multiple Iterative Deepening) ループを実装し、proof/disproof number で最も証明に近い分岐を優先展開。

加えて、噛み先（AND節点）に等価クラス最適化を追加。全ワールドで同じ roleId の席は同型の部分木を生むため、代表1つだけ simulate（FNVハッシュで等価判定）。

- `buildStrategy=true`（戦略構築）: 従来の DFS を維持。non-build パスの分岐削除で若干軽量化。
- `buildStrategy=false`（判定のみ）: DFPN + 噛み等価クラスで高速判定。Fenrir 学習パイプライン向け。

verify.ts: 全通過（2,455詰み検証）
DFS worst: 25.9ms → 10.2ms（噛み等価クラス不要ケースでも non-build 分岐削除により改善）

### 9. 役職名参照を属性ベース化 (Phase 6, 2026-05-28)

`World` 型の役職別マスク (`wolfMask` / `hamsterMask` / `seerMask` / `mediumMask` / `nekomataMask` / `immoralistMask` / `bodyguardSeat`) を属性別マスクに置換。

新ファイル `role-attributes.ts` に `ATTR.*` ビット定数と `RoleAttributeBits` (RoleBitIndex → 属性ビット集合) を集約。`worlds.ts` の backtrack は trait に基づき 11 マスクを増分更新する。

設計目的: 新役職 (paparazzi 等) を追加するとき Hati 側のコード変更を不要にする。Hati 内のロジック (`buildThreatProfile` / `checkOutcome` / `simulateNight` / `validBiteTargetsMask` / `applyFollowDeaths` / `isExecInsufficient`) は属性マスクの AND・補集合・popCount だけで判定。

BEFORE / AFTER (14d-neko + small-8p + 14d-neko-10k 連続実行、ベンチマーク同一機械):

| 項目 | BEFORE | AFTER | 差 |
|---|---|---|---|
| Total wall | 986627ms | 976616ms | −1% (perf 中立) |
| 14d-neko-10k Day1 max | 8.5ms | 8.4ms | −0.1ms |
| 14d-neko-10k Day2 max | 7.7ms | 9.0ms | +1.3ms |
| 14d-neko-10k Day10 avg | 0.01ms | 0.01ms | 同 |
| Total checkpoints | 49521 | 49521 | 同 |

backtrack 内で 1 役職あたり最大 11 個の属性マスク AND/OR 演算が発生するが、`if (attr & ATTR.X)` 早期排他により実質的に「その役職が持つ trait 数」分の書き込みのみ。多くの役職は 0〜2 traits なので overhead は最小。

副次効果: `reactive:follow-fox-death` trait を [src/types/index.ts](../types/index.ts) に追加し immoralist の能力を明示。retar-rs (Rust) 側も同期。

### 6. 役職追加コスト削減 (trait-purge Phase 1-6, 2026-05-31)

役職追加で `src/hati/puzzle.ts` の `ALL_ROLES` / `VILLAGE_ROLES` / `OUTSIDER_ROLES` を手動更新する必要があった (paparazzi 追加時の漏れ実例あり)。これを [src/retar/role-sets.ts](../retar/role-sets.ts) の `allKnownRoles()` / `allVillageRoles()` / `allLiarRoles()` 経由の `systemRoles` 派生に置換。`wolfRisk.ts` の `'werewolf' as SystemRole` literal も `singleRoleBySeerResult('wolf')` const 経由に。

retar 側も `LiarRoles` / `HumanRoles` / `RoleSignatureBits` / `RoleBitIndex` / `ROLE_COUNT` / `Liar` / `VillageRoles` を `systemRoles` 派生に統一。 paparazzi 追加で `LiarRoles` / `HumanRoles` に paparazzi が抜けていたバグも構造的に解消。

BEFORE / AFTER (post-paparazzi-merge → trait-purge Phase 6 完了、同一機械):

| 項目 | BEFORE (post-merge) | AFTER (trait-purge) | 差 |
|---|---|---|---|
| Total wall | 1028049ms | 1035704ms | +0.74% (誤差範囲) |
| 14d-neko-10k endgame entries | 604 | 604 | 同 |
| 14d-neko-10k endgame hits | 7701 | 7701 | 同 |
| retar TS bench | 1398ms | 1429ms | +2.2% (誤差範囲) |
| retar WASM bench | 336ms | 329ms | −2.1% (誤差範囲) |

hot path 内の trait helper 呼び出しは module-level const に固定したため、追加 overhead はほぼゼロ。`countByTraitIn(setup, ...)` のような setup 集計関数も関数 entry で 1 回キャッシュする pattern を維持。

副次効果: 役職追加時に retar / hati の役職名列挙テーブルを触らなくて良くなった。 systemRoles に entry を 1 つ追加するだけで Liar / Human / VILLAGE_ROLES / OUTSIDER_ROLES / RoleSignatureBits / ROLE_COUNT がすべて自動拡張。 paparazzi 追加で踏んだ `Liar` 欠落バグ (Phase 8 で発見) は構造的に発生不可能になる。

retar-rs (Rust) 側は最小スコープで同期: `role_sets.rs` を新規追加して TS の helper 群を pub fn として export、 sync-check pass。 既存 Rust 内部ロジックは literal を残置 (役職追加で手動更新が必要、 段階的 trait 化は別タスク)。

## 未実装の最適化案

### 反復深化

浅い深さで先に探索し、詰みなしなら即棄却。深い探索が不要なケースを高速排除。
