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
