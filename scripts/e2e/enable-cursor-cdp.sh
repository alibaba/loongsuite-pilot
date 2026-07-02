#!/bin/bash
# ============================================================
# Enable Chrome DevTools Protocol (CDP) on Cursor IDE
#
# 两步操作让 Cursor 开启 CDP:
#   1) Patch main.js 白名单 — 在简单数组中添加 "remote-debugging-port","remote-allow-origins"
#   2) argv.json 配置 — "remote-debugging-port": "9222" (值必须是字符串, 不能是数字)
#      因为 Cursor 源码用 typeof l == "string" 判断, 数字类型不会触发 appendSwitch
#
# macOS Ventura+ 注意:
#   修改 /Applications 下的文件需要先在
#   系统设置 → 隐私与安全性 → App Management 中给终端 (Terminal/iTerm) 授权
#
# Cursor 更新会覆盖 main.js, 需重新运行此脚本。
#
# 用法:
#   bash enable-cursor-cdp.sh          # 默认端口 9222
#   bash enable-cursor-cdp.sh 9333     # 自定义端口
# ============================================================

set -e

CDP_PORT="${1:-9222}"

# ── 平台检测 ──

case "$(uname -s)" in
  Darwin)
    PLATFORM="macos"
    MAIN_JS="/Applications/Cursor.app/Contents/Resources/app/out/main.js"
    ;;
  Linux)
    PLATFORM="linux"
    MAIN_JS=""
    for _p in /usr/share/cursor/resources/app/out/main.js /opt/cursor/resources/app/out/main.js; do
      [ -f "$_p" ] && MAIN_JS="$_p" && break
    done
    ;;
  MINGW*|MSYS*|CYGWIN*)
    PLATFORM="windows"
    MAIN_JS="${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/Cursor/resources/app/out/main.js"
    ;;
  *)
    PLATFORM="linux"
    MAIN_JS=""
    ;;
esac

ARGV_JSON="$HOME/.cursor/argv.json"

echo "=== Cursor CDP Enabler ==="
echo "Platform:    $PLATFORM"
echo "Target port: $CDP_PORT"
echo "main.js:     ${MAIN_JS:-not found}"
echo "argv.json:   $ARGV_JSON"
echo ""

# ── Step 1: Patch main.js 白名单 ──

echo "[1/3] Patching main.js whitelist..."

if [ -z "$MAIN_JS" ] || [ ! -f "$MAIN_JS" ]; then
    echo "ERROR: Cursor main.js not found at ${MAIN_JS:-<unknown>}"
    echo "  Cursor 未安装或安装路径非标准, 请手动指定 MAIN_JS 环境变量"
    exit 1
fi

# 检查是否已 patch (匹配数组中的位置: ..."remote-allow-origins"])
if grep -q '"remote-debugging-port","remote-allow-origins"\]' "$MAIN_JS"; then
    echo "  -> Already patched, skipping."
else
    # macOS Ventura+ 写权限检查
    if [ "$PLATFORM" = "macos" ] && ! [ -w "$MAIN_JS" ]; then
        echo "ERROR: 无写入权限: $MAIN_JS"
        echo ""
        echo "  macOS Ventura+ 需要先授权终端修改 /Applications 下的文件:"
        echo "  系统设置 → 隐私与安全性 → App Management → 勾选你的终端 (Terminal/iTerm/Warp)"
        echo "  授权后重新运行此脚本"
        exit 1
    fi

    # Backup
    cp "$MAIN_JS" "${MAIN_JS}.bak"
    echo "  -> Backup: ${MAIN_JS}.bak"

    # Patch: 在简单数组的 "proxy-bypass-list"] 后插入新条目
    # 白名单格式: ["disable-hardware-acceleration","force-color-profile","disable-lcd-text","proxy-bypass-list"]
    # 注意: main.js 中 "proxy-bypass-list" 出现多次 (简单数组 + {type:"string"} map),
    #       必须精确匹配 "proxy-bypass-list"] (后跟]) 避免破坏 map 格式
    sed -i.tmp 's/"proxy-bypass-list"\]/"proxy-bypass-list","remote-debugging-port","remote-allow-origins"]/' "$MAIN_JS"
    rm -f "${MAIN_JS}.tmp"

    if grep -q '"proxy-bypass-list","remote-debugging-port"' "$MAIN_JS"; then
        echo "  -> Patch applied."
    else
        echo "ERROR: Patch failed — sed pattern not matched. Cursor 版本可能已变化。"
        echo "  Restoring backup..."
        cp "${MAIN_JS}.bak" "$MAIN_JS"
        exit 1
    fi
fi

# ── Step 2: 配置 argv.json ──

echo "[2/3] Configuring $ARGV_JSON..."

mkdir -p "$(dirname "$ARGV_JSON")"

# Python 在 Git Bash/MSYS 下不认 /c/... 路径, 通过环境变量传递让 Python 用 os.path.expanduser
_ARGV_PY_PATH="$ARGV_JSON"
if [[ "$PLATFORM" == "windows" ]]; then
    _ARGV_PY_PATH="$(cd "$(dirname "$ARGV_JSON")" && pwd -W)/$(basename "$ARGV_JSON")"
fi

if [ -f "$ARGV_JSON" ]; then
    if grep -q '"remote-debugging-port"' "$ARGV_JSON"; then
        # 已有配置 — 用 python3 安全更新 JSON (避免 sed 破坏格式)
        ARGV_FILE="$_ARGV_PY_PATH" CDP_PORT_VAL="$CDP_PORT" python3 -c "
import os, re
fpath = os.environ['ARGV_FILE']
port = os.environ['CDP_PORT_VAL']
with open(fpath) as f:
    content = f.read()
content = re.sub(
    r'\"remote-debugging-port\"\s*:\s*\"?[^,}\n]*\"?',
    '\"remote-debugging-port\": \"' + port + '\"',
    content
)
with open(fpath, 'w') as f:
    f.write(content)
" 2>/dev/null
        echo "  -> Updated port to $CDP_PORT (string)."
    else
        # 没有该字段 — 在最后一个 } 前插入
        ARGV_FILE="$_ARGV_PY_PATH" CDP_PORT_VAL="$CDP_PORT" python3 -c "
import os, re
fpath = os.environ['ARGV_FILE']
port = os.environ['CDP_PORT_VAL']
with open(fpath) as f:
    content = f.read()
content = re.sub(r'(\r?\n)(}\s*)$', r',\n\n\t\"remote-debugging-port\": \"' + port + r'\"\n}', content)
with open(fpath, 'w') as f:
    f.write(content)
"
        echo "  -> Added remote-debugging-port: \"$CDP_PORT\"."
    fi
else
    cat > "$ARGV_JSON" << EOF
{
	"remote-debugging-port": "$CDP_PORT"
}
EOF
    echo "  -> Created $ARGV_JSON."
fi

# 验证值是字符串格式
if grep -qE '"remote-debugging-port"[[:space:]]*:[[:space:]]*[0-9]' "$ARGV_JSON" && \
   ! grep -qE '"remote-debugging-port"[[:space:]]*:[[:space:]]*"' "$ARGV_JSON"; then
    echo "WARNING: argv.json 中 remote-debugging-port 的值是数字, 不是字符串"
    echo "  Cursor 源码用 typeof l == \"string\" 判断, 数字值不会生效"
    echo "  当前值将被修正..."
    ARGV_FILE="$_ARGV_PY_PATH" python3 -c "
import os, re
fpath = os.environ['ARGV_FILE']
with open(fpath) as f:
    content = f.read()
content = re.sub(
    r'\"remote-debugging-port\"\s*:\s*(\d+)',
    r'\"remote-debugging-port\": \"\1\"',
    content
)
with open(fpath, 'w') as f:
    f.write(content)
"
    echo "  -> Fixed: value is now a string."
fi

# ── Step 3: 重启 Cursor ──

echo "[3/3] Restarting Cursor..."

# 检查 Cursor 是否在运行
if pgrep -f "Cursor.app/Contents/MacOS" >/dev/null 2>&1 || \
   pgrep -f "cursor.*--type=browser" >/dev/null 2>&1; then
    echo ""
    echo "  ⚠ Cursor 正在运行, 将关闭并重启。请确认已保存工作。"
    # 仅在交互式终端(非 CI/自动化)下等待确认;无 TTY 时直接继续
    if [ -t 0 ] && [ -z "${CI:-}" ]; then
        echo "  按 Enter 继续, 或 Ctrl+C 取消..."
        read -r
    else
        echo "  非交互环境, 自动继续重启 Cursor..."
    fi
    if [ "$PLATFORM" = "macos" ]; then
        osascript -e 'quit app "Cursor"' 2>/dev/null || killall Cursor 2>/dev/null || true
    else
        killall cursor 2>/dev/null || true
    fi
    sleep 3
fi

if [ "$PLATFORM" = "macos" ]; then
    open -a /Applications/Cursor.app
elif command -v cursor >/dev/null 2>&1; then
    cursor &
fi
echo "  -> Cursor restarting..."

# 等待 CDP 就绪
echo ""
echo "Waiting for CDP..."
for i in $(seq 1 15); do
    sleep 1
    if curl -s "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; then
        echo ""
        echo "=== SUCCESS ==="
        echo "CDP is live at http://127.0.0.1:$CDP_PORT"
        echo ""
        curl -s "http://127.0.0.1:$CDP_PORT/json/version" | python3 -m json.tool 2>/dev/null || \
            curl -s "http://127.0.0.1:$CDP_PORT/json/version"
        exit 0
    fi
    printf "."
done

echo ""
echo "WARNING: CDP not responding after 15s. Cursor may still be starting up."
echo "  Try: curl http://127.0.0.1:$CDP_PORT/json/version"
