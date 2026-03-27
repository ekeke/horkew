#!/bin/bash
# Retar Rust/WASM build script (runs in Docker)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RETAR_RS="C:\Users\aklas\dev\horkew\.claude\worktrees\swift-chasing-dawn\src\retar-rs"

case "${1:-build}" in
  test)
    docker run --rm -v "$RETAR_RS:/app" retar-wasm -c "cargo test 2>&1"
    ;;
  build)
    docker run --rm -v "$RETAR_RS:/app" retar-wasm -c "wasm-pack build --target nodejs --out-dir pkg 2>&1"
    ;;
  build-web)
    docker run --rm -v "$RETAR_RS:/app" retar-wasm -c "wasm-pack build --target web --out-dir pkg-web 2>&1"
    ;;
  *)
    echo "Usage: $0 {test|build|build-web}"
    exit 1
    ;;
esac
