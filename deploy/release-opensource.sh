#!/usr/bin/env bash
# Rust 发布薄入口：默认只核对六平台候选并生成本地发布资产。
# 正式发布必须显式传入已有 --tag 和 --publish；不自动 bump、commit、tag 或上传 OSS。
# 旧 --patch/--minor/--major/--version/--oss-only 参数由 xtask 拒绝。
# 示例：bash deploy/release-opensource.sh --packages target/release-input \
#   --output target/release-assets --commit <完整SHA> --repository <owner/repo>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
exec cargo run --locked --manifest-path "$PROJECT_ROOT/Cargo.toml" -p xtask -- release "$@"
