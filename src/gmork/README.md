# Gmork

役職否定理由の言語化ライブラリ。

Retarが「何が可能か」を計算するのに対し、Gmorkは「なぜその役職が不可能なのか」を人間向けテキストで説明する。

## 入力

Retarと同じ入力に加え、説明対象の席と役職を指定する。

```typescript
import { explain } from './index.ts'

const reason = explain(villageStatus, setup, seat, role)
// => "3d: プレイヤーCの占い白判定" など
```

| パラメータ | 型 | 説明 |
|---|---|---|
| `village` | `VillageStatus` | 村の状態（Retarと同じ） |
| `setup` | `Map<SystemRole, number>` | 配役（Retarと同じ） |
| `seat` | `Seat` (number) | 対象の席番号 |
| `role` | `SystemRole` | 否定された役職 |

## 出力

否定理由を説明する日本語文字列を返す。理由が特定できない場合は `'わかりません'` を返す。

## 設計方針

- Retarとは独立した軽量チェッカーとして動作する
- 構造化データ (`DenialReason`) を内部で生成し、フォーマッターで文字列に変換する（将来）
- 現時点ではスタブ実装（常に `'わかりません'` を返す）
