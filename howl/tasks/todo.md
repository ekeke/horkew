# Howl 実装TODOリスト

## 1. フロントマター（YAML）がWindowsで認識されない

- [x] `cli.ts` で CRLF → LF 変換して対応

## 2. 人外CO（非村陣営の役職CO）が未実装

- [x] `Assertion.roles` に `'nonVillage'` としてマッピング
- [x] throw を削除、extractRoles で村陣営以外は nonVillage にフォールバック

## 3. FlexibleDictionaryがパースに未統合

- [ ] クラス自体は実装・テスト済み
- [ ] `parser.ts` / `statement.ts` から一切使われていない
- [ ] READMEに記載の前方一致・部分一致・2文字省略の名前解決が動かない

## 4. example.howlでunknownになる構文のパーサー実装

- [x] 共有発表: `parseMasonStatement` を追加
- [x] CO無し霊能結果: historyRegexText の target を省略可能に
- [x] 複合役職CO: claim を `(?:anyRole)+CO` に変更、roles 配列で保持
- [x] 護衛履歴付きCO: historyRegexText に guard アクションを追加
- [x] 平和（噛みなし）: `parsePeaceStatement` を追加
- [x] 護衛宣言: 護衛アクション対応で自動的に解決
- [x] 噛みバリエーション: `parseAttackStatement` に逆順パターン追加
- [x] 役職公開（=形式）: `parseRevealStatement` を追加

## 5. ルールセットが未使用

- [ ] `ruleset.ts` で10種のゲームルールが定義済み
- [ ] パース処理やバリデーションで一切参照されていない

## 6. index.d.ts がViteテンプレートのまま

- [ ] `setupCounter` をexportしている
- [ ] 実際のパーサーAPI（`parse` 関数、Statement型など）が公開されていない
