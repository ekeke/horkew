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

# Clean cached build artifacts inside container to avoid stale intermediate objects
CLEAN="find target -mindepth 1 -delete 2>/dev/null; "

case "${1:-build}" in
  test)
    docker run --rm -v "$MOUNT_DIR:/app" retar-wasm -c "${CLEAN}cargo test 2>&1"
    ;;
  build)
    docker run --rm -v "$MOUNT_DIR:/app" retar-wasm -c "${CLEAN}wasm-pack build --target nodejs --out-dir pkg 2>&1 && rm -f pkg/.gitignore"
    ;;
  build-web)
    docker run --rm -v "$MOUNT_DIR:/app" retar-wasm -c "${CLEAN}wasm-pack build --target web --out-dir pkg-web 2>&1 && rm -f pkg-web/.gitignore"
    ;;
  build-dump)
    docker run --rm -v "$MOUNT_DIR:/app" retar-wasm -c "${CLEAN}wasm-pack build --target nodejs --out-dir pkg -- --features dump 2>&1 && rm -f pkg/.gitignore"
    ;;
  all)
    docker run --rm -v "$MOUNT_DIR:/app" retar-wasm -c "${CLEAN}cargo test 2>&1 && wasm-pack build --target nodejs --out-dir pkg 2>&1 && rm -f pkg/.gitignore && wasm-pack build --target web --out-dir pkg-web 2>&1 && rm -f pkg-web/.gitignore"
    ;;
  *)
    echo "Usage: $0 {test|build|build-web|build-dump|all}"
    exit 1
    ;;
esac
