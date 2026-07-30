#!/usr/bin/env bash
# 拉取 loongsuite-pilot-installer 插件所需的多平台 Node 分发包到 vendor/node/。
# 产物不入 git（体积大），用于上传 OSS 供插件在线下载（平铺、公读）：
#   ossutil cp -r -f vendor/node/ oss://taiye-test-sh/sensen-test/ --acl public-read
# 上传前缀需与 config/install-params.conf 的 NODE_DIST_BASE_URL 一致，
# 插件请求地址：<base>/node-v<ver>-<platform>.tar.gz
set -euo pipefail

NODE_VERSION="${1:-22.22.2}"
BASE_URL="${NODE_UPSTREAM_URL:-https://nodejs.org/dist}"
VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/node"

# 平台矩阵：mac(arm64/x64)、linux(x64/arm64)、windows(x64, zip)
TARBALLS=(
    "node-v${NODE_VERSION}-darwin-arm64.tar.gz"
    "node-v${NODE_VERSION}-darwin-x64.tar.gz"
    "node-v${NODE_VERSION}-linux-x64.tar.gz"
    "node-v${NODE_VERSION}-linux-arm64.tar.gz"
    "node-v${NODE_VERSION}-win-x64.zip"
)

mkdir -p "$VENDOR_DIR"
echo "==> 拉取 Node v${NODE_VERSION} 分发包到 $VENDOR_DIR"

# 校验和清单（用于下载完整性校验）
curl -fsSL "$BASE_URL/v${NODE_VERSION}/SHASUMS256.txt" -o "$VENDOR_DIR/SHASUMS256.txt"

for tarball in "${TARBALLS[@]}"; do
    dest="$VENDOR_DIR/$tarball"
    if [ -f "$dest" ]; then
        echo "  ✓ 已存在: $tarball"
    else
        echo "  ↓ 下载: $tarball"
        curl -fL --progress-bar "$BASE_URL/v${NODE_VERSION}/$tarball" -o "$dest"
    fi
    expected=$(grep " $tarball\$" "$VENDOR_DIR/SHASUMS256.txt" | awk '{print $1}')
    actual=$(shasum -a 256 "$dest" 2>/dev/null | awk '{print $1}' || sha256sum "$dest" | awk '{print $1}')
    if [ "$expected" != "$actual" ]; then
        echo "  ❌ 校验失败: $tarball" >&2
        exit 1
    fi
    echo "    sha256 OK"
done

echo "==> 完成。产物清单："
ls -lh "$VENDOR_DIR"
