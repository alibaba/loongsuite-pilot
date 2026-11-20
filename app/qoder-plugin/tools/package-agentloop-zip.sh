#!/usr/bin/env bash
# 维护者工具（不随插件分发）：把 agentloop 插件目录打成可分发的 zip。
# 产物结构：zip 内只有一层目录 agentloop/，其下直接是 .qoder-plugin/plugin.json。
# Qoder 安装 zip 时，根目录不是插件就只再看唯一的一层子目录。版本号写在文件名里。
# 默认排除测试、缓存、本机 CLI 凭证与系统垃圾。
# 用 tar -a 而不是 zip：本机 zip 不认 -UN=UTF8，中文示例名不会带 UTF-8 标记。
# 用法：
#   ./package-agentloop-zip.sh                 # 打插件本体
#   ./package-agentloop-zip.sh -o /tmp         # 指定产物输出目录
set -euo pipefail

OUT_DIR=""
while [ $# -gt 0 ]; do
    case "$1" in
        -o|--out)    OUT_DIR="$2"; shift 2 ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
done

# 本脚本位于 app/qoder-plugin/tools/，插件在同级目录
TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$TOOLS_DIR/../agentloop" && pwd)"
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
echo "    产物: $ZIP_PATH"

# 源路径带结尾斜杠，拷进 staging 后顶层就是 agentloop/，不再套版本目录。
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
mkdir -p "$STAGE_DIR/$PLUGIN_NAME"

RSYNC_EXCLUDES=( --exclude='.DS_Store'
    --exclude='tests' --exclude='__pycache__' --exclude='*.pyc'
    --exclude='aliyun' )
rsync -a "${RSYNC_EXCLUDES[@]}" "$PLUGIN_DIR/" "$STAGE_DIR/$PLUGIN_NAME/"

# COPYFILE_DISABLE 避免 macOS tar 把 ._* 资源叉打进去。Linux 上这个变量无影响。
( cd "$STAGE_DIR" && COPYFILE_DISABLE=1 tar -a -cf "$ZIP_PATH" "$PLUGIN_NAME" )

echo "==> 完成。内容清单："
unzip -l "$ZIP_PATH"
echo "==> zip 大小: $(du -h "$ZIP_PATH" | awk '{print $1}')"
