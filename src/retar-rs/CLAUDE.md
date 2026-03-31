# retar-rs — Rust/WASM版Retar

## ビルド

DockerベースのWASMビルド。初回は `docker build -t retar-wasm .` でイメージを作成する。

```bash
npm run test:rust          # Rustテストのみ
npm run build:wasm         # テスト + node pkg + web pkg (全部)
npm run build:wasm:node    # node pkg のみ
npm run build:wasm:web     # web pkg のみ
```

### 注意: `target/` ディレクトリの権限問題

Docker内で `/app/target` を作成する際に権限エラーが出る場合がある。
`npm run test:rust` を先に実行すると `target/` が作成され、後続の `build:wasm` が通るようになる。

## TS↔Rust 同一性規約

ルートの CLAUDE.md「TS↔Rust 同一性規約」セクションを参照。以下は Rust 固有の補足:

- `sync-check.test.ts` が TS↔Rust の関数名・メソッド名の一致を静的検証する。新しい `pub fn` を追加したら TS 側にも対応関数を追加すること
- 副作用のある関数は `update_...` / `apply_...` の動詞を使う。読み取り専用は `check_...` / `validate_...`
- `pub fn` のみが比較対象。`pub(crate)` や非公開関数は sync-check の対象外
- テストモジュール（`#[cfg(test)]`）内の関数も比較対象外
