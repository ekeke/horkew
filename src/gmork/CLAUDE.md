# Gmork: 開発ガイド

## ゴール

Gmorkは**完璧な推論エンジンではない**。推論エンジン（充填問題ソルバ）はRetarが担う。

Gmorkの目的は、**人狼ゲームでの典型的な推理パターンを初心者に提示すること**。
Retarが「AはSeerではありえない」と計算した結果に対し、「なぜそうなるか」を人間が理解できる言葉で説明する。

- わからないときは「わかりません」と答えてよい
- Retarが出した結論を全て説明する必要はない
- 説明できる範囲で、初心者にとって分かりやすい推理の筋道を示すことが価値

## カテゴリ設計（axiomatic / dependent / elimination）

理由（reason）は依存性の性質で3カテゴリに分類される。旧Tier制（0-4）は廃止。

### axiomatic（自明）
ゲーム事実のみで完結し、他のreasonに一切依存しない。循環チェック不要。
例: 死因、CO事実、セットアップ制約、偽者予算計算

### dependent（依存）
他プレイヤーの確定/破綻を根拠にする。**返す前に依存先の説明可能性を検証する**。
依存先がaxiomaticに説明できなければ、その理由はスキップ（「わからない」）にする。
例: 確定占い師の結果、CO破綻分析、合意判定

### elimination（消去法）
複数の否定/確定の集合に依存する。内部で独自にガードしている。
例: 枠充足、鳩の巣原理、全役職否定による消去法

## 循環防止の設計

dependent理由が循環する問題（「AがダメだからBが確定、Bが確定だからAダメ」）を防ぐため、
依存先の確定をaxiomaticチェッカーで説明できるか検証する。

再帰の終端保証:
```
isDependencyExplainable → hasExplainableConfirmation → isConfirmationDependencyExplainable
  → areBustsExplainable → isBustExplainable → hasAxiomaticConfirmation（axiomatic限定で終端）
```

`hasExplainableConfirmation` はdependentも試すが、その内部のbust検証は `hasAxiomaticConfirmation`（厳格版）で止まる。

## チェッカーの実行順序

axiomatic → dependent → elimination の順。同カテゴリ内は旧Tier順を維持。
axiomaticが先に試されるため、シンプルな説明が優先される。
