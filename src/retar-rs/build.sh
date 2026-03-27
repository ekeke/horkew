#!/bin/bash
# Retar Rust/WASM build script (runs in Docker)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Convert MSYS/Git Bash paths to Windows paths for Docker volume mounts
if command -v cygpath > /dev/null 2>&1; then
  MOUNT_DIR="$(cygpath -w "$SCRIPT_DIR")"
else
  MOUNT_DIR="$SCRIPT_DIR"
fi

case "${1:-build}" in
  test)
    docker run --rm -v "$MOUNT_DIR:/app" retar-wasm -c "cargo test 2>&1"
    ;;
  build)
    docker run --rm -v "$MOUNT_DIR:/app" retar-wasm -c "wasm-pack build --target nodejs --out-dir pkg 2>&1"
    ;;
  build-web)
    docker run --rm -v "$MOUNT_DIR:/app" retar-wasm -c "wasm-pack build --target web --out-dir pkg-web 2>&1"
    ;;
  all)
    docker run --rm -v "$MOUNT_DIR:/app" retar-wasm -c "cargo test 2>&1 && wasm-pack build --target nodejs --out-dir pkg 2>&1 && wasm-pack build --target web --out-dir pkg-web 2>&1"
    ;;
  *)
    echo "Usage: $0 {test|build|build-web|all}"
    exit 1
    ;;
esac
