#!/usr/bin/env bash
# 维护者工具（不随插件分发）：把 loongsuite-pilot-installer 插件目录打成可分发的 zip。
# 产物结构：zip 内顶层是版本目录 loongsuite-pilot-installer-<version>/，其下是插件本体
#   loongsuite-pilot-installer/，任意解压器解开后都得到统一的版本目录，再直接
#   qodercli plugins install /path/to/loongsuite-pilot-installer-<version>/loongsuite-pilot-installer
# 默认排除 vendor/node/（体积大、hook 在线下载）与运行期落盘文件。
# 用法：
#   ./package-plugin-zip.sh                 # 只打插件本体（推荐，联网下载 node）
#   ./package-plugin-zip.sh --with-node     # 连 vendor/node/ 一起打（离线分发）
#   ./package-plugin-zip.sh -o /tmp         # 指定产物输出目录
set -euo pipefail

WITH_NODE=0
OUT_DIR=""
while [ $# -gt 0 ]; do
    case "$1" in
        --with-node) WITH_NODE=1; shift ;;
        -o|--out)    OUT_DIR="$2"; shift 2 ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
done

# 本脚本位于 app/qoder-plugin/tools/，插件在同级目录
TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$TOOLS_DIR/../loongsuite-pilot-installer" && pwd)"
PLUGIN_NAME="$(basename "$PLUGIN_DIR")"
QODER_ROOT="$(cd "$TOOLS_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-$QODER_ROOT/dist}"

MANIFEST="$PLUGIN_DIR/.qoder-plugin/plugin.json"
[ -f "$MANIFEST" ] || { echo "❌ 找不到 manifest: $MANIFEST" >&2; exit 1; }

# 从 plugin.json 读版本号（避免依赖 jq，用 grep/sed 提取 "version": "x.y.z"）
VERSION="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$MANIFEST" \
    | head -1 | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')"
[ -n "$VERSION" ] || { echo "❌ 无法从 $MANIFEST 解析 version" >&2; exit 1; }

mkdir -p "$OUT_DIR"
ZIP_PATH="$OUT_DIR/${PLUGIN_NAME}-${VERSION}.zip"
rm -f "$ZIP_PATH"

echo "==> 打包 $PLUGIN_NAME v$VERSION"
echo "    源目录: $PLUGIN_DIR"
echo "    vendor/node: $([ "$WITH_NODE" -eq 1 ] && echo '包含（离线分发）' || echo '排除（在线下载）')"
echo "    产物: $ZIP_PATH"

# 先把插件拷进版本目录 loongsuite-pilot-installer-<version>/loongsuite-pilot-installer/，
# 再从 staging 打包，保证 zip 内顶层是版本目录（任意解压器都得到统一的版本目录）。
WRAP_NAME="${PLUGIN_NAME}-${VERSION}"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
mkdir -p "$STAGE_DIR/$WRAP_NAME"

RSYNC_EXCLUDES=( --exclude='.DS_Store'
    --exclude='install.log' --exclude='install.lock'
    --exclude='install-args.sha256' --exclude='installer.sh' --exclude='installer.ps1' )
if [ "$WITH_NODE" -eq 0 ]; then
    RSYNC_EXCLUDES+=( --exclude='vendor/node' )
fi
rsync -a "${RSYNC_EXCLUDES[@]}" "$PLUGIN_DIR" "$STAGE_DIR/$WRAP_NAME/"

( cd "$STAGE_DIR" && zip -r -q "$ZIP_PATH" "$WRAP_NAME" )

echo "==> 完成。内容清单："
unzip -l "$ZIP_PATH"
echo "==> zip 大小: $(du -h "$ZIP_PATH" | awk '{print $1}')"
