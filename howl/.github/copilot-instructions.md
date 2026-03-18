# copilotへの指示


## テストフレームワーク

 - このプロジェクトでは、node:testとnode:assertを使用してテストを記述しています。Vitestや他のテストフレームワークは使用しません。

## TypeScriptの扱い

 - TypeScriptファイル（.ts）はトランスパイルせず、Node.jsの実験的な--experimental-strip-types機能を使用して実行しています。
 - tscによるコンパイルは行わず、型チェックはVSCodeの機能に依存しています。

## テスト実行

 - テストはnpm testコマンドを使用して実行します。
   - node --experimental-strip-types --testが内部的に使用されます。

## TypeScript / JavaScript のコーディングガイドライン

 - 行末のセミコロンは可能な限り省略する

