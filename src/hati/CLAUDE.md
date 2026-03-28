# Hati — 詰み探索エンジン

## 最重要: 判定と探索は別物

```
判定 (judgeTsumi)    ← Retarの可能性ビットだけで完結。ワールド列挙しない。
探索 (searchTsumiStrategy) ← 詰み手順の構築。ワールド列挙が必要。オプショナル。
```

### 判定フェーズ

- **計算だけで詰みの可否を決定する。**
- 入力: Retarの `Possibilities`（各席の役職可能性ビットマスク）
- 出力: `TsumiJudgment`（tsumiCoeff, nawa, threat, impossible）
- ワールド列挙もAND-OR探索も行わない
- `isThreatExceeded` が判定ロジックを担当

### 探索フェーズ

- **判定で「詰みあり」かつ手順構築が要求された場合のみ**実行される
- ワールド列挙 → 枝刈り → AND-OR木探索
- `isExecInsufficient`, `simulateFoxElimination` は探索の枝刈り（探索高速化のため）
- これらは判定には使わない

### なぜこうなっているか

Hatiは当初、AND-OR全探索で詰みを判定する設計だった。
途中で「計算だけで判定が出せる」というピボットが起き、
探索は手順構築のためだけに残った。
この経緯を知らないと、枝刈り関数を判定条件と混同しやすい。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `index.ts` | 公開API: `searchTsumi`, `judgeTsumi`, `searchTsumiStrategy` |
| `types.ts` | 型定義: `World`, `TsumiJudgment`, `TsumiResult`, `SearchOptions` |
| `search.ts` | AND-OR木探索エンジン |
| `foxResolver.ts` | 狐排除可能性の探索（探索フェーズの枝刈り） |
| `simulate.ts` | 夜フェーズシミュレーション |
| `worlds.ts` | ワールド列挙（探索フェーズ用） |
| `verify.ts` | 正しさ検証スクリプト |
| `bench.ts` | ベンチマーク |
