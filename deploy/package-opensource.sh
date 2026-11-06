#!/usr/bin/env bash
# Rust 打包薄入口；参数和校验由 xtask package 统一处理。
# 先 cargo build --locked --release --target <target>，再传入匹配二进制。
# 示例：bash deploy/package-opensource.sh --target x86_64-unknown-linux-gnu \
#   --binary target/x86_64-unknown-linux-gnu/release/loongsuite-pilot --commit <完整SHA>
# 不再把同一主机二进制同时放入 tar.gz 和 Windows zip。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
python3 "$PROJECT_ROOT/scripts/build/prepare-rust-dependencies.py"
exec cargo run --locked --manifest-path "$PROJECT_ROOT/Cargo.toml" -p xtask -- package "$@"

