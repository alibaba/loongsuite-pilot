#!/usr/bin/env bash
# loongsuite-pilot-installer 插件 SessionStart hook：
# 幂等检测并安装 loongsuite-pilot，缺 node>=22 时先代装 nvm + node 22。
# 日志与并发锁写入 QODER_PLUGIN_DATA（跨插件升级保留）。
set -uo pipefail

INSTALLER_URL="https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/installer.sh"
NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh"
NODE_MIN_MAJOR=22
USER_ID="${LOONGSUITE_PILOT_USER_ID:-536799}"

PILOT_BIN="$HOME/.local/bin/loongsuite-pilot"
DATA_DIR="${QODER_PLUGIN_DATA:-$HOME/.loongsuite-pilot-installer}"
LOG_FILE="$DATA_DIR/install.log"
LOCK_DIR="$DATA_DIR/install.lock"

mkdir -p "$DATA_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# 幂等：已安装直接退出（每次会话启动都会触发本脚本）
if [ -x "$PILOT_BIN" ] || [ -x /usr/local/bin/loongsuite-pilot ]; then
    exit 0
fi

# 并发锁：多会话同时启动时只允许一个实例执行安装
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "另一实例正在安装，跳过"
    exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

log "未检测到 loongsuite-pilot，开始自动安装 (user.id=$USER_ID)"

# --- 确保 node >= 22 ---
find_node22() {
    local d major
    for d in "$HOME/.nvm/versions/node"/*/bin; do
        [ -x "$d/node" ] || continue
        major=$(basename "$(dirname "$d")" | sed 's/^v//' | cut -d. -f1)
        [ "$major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null && { echo "$d"; return 0; }
    done
    if command -v node >/dev/null 2>&1; then
        major=$(node -v | sed 's/^v//' | cut -d. -f1)
        [ "$major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null && { dirname "$(command -v node)"; return 0; }
    fi
    return 1
}

NODE_BIN_DIR=$(find_node22 || true)
if [ -z "$NODE_BIN_DIR" ]; then
    log "未检测到 node >= $NODE_MIN_MAJOR，代装 nvm + node $NODE_MIN_MAJOR"
    if curl -o- "$NVM_INSTALL_URL" 2>>"$LOG_FILE" | bash >> "$LOG_FILE" 2>&1; then
        export NVM_DIR="$HOME/.nvm"
        # shellcheck disable=SC1091
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        nvm install "$NODE_MIN_MAJOR" >> "$LOG_FILE" 2>&1
    fi
    NODE_BIN_DIR=$(find_node22 || true)
    if [ -z "$NODE_BIN_DIR" ]; then
        log "❌ nvm/node 代装失败，终止"
        echo "loongsuite-pilot 自动安装失败：node >= $NODE_MIN_MAJOR 环境准备失败，详见 $LOG_FILE" >&2
        exit 1
    fi
    log "node 代装完成: $NODE_BIN_DIR"
else
    log "node 环境就绪: $NODE_BIN_DIR"
fi
export PATH="$NODE_BIN_DIR:$HOME/.local/bin:$PATH"

# --- 一键安装 loongsuite-pilot ---
if curl -fsSL "$INSTALLER_URL" 2>>"$LOG_FILE" | bash -s -- install --user.id "$USER_ID" >> "$LOG_FILE" 2>&1; then
    STATUS=$("$PILOT_BIN" status 2>&1 || true)
    log "✅ 安装完成。status: $STATUS"
    # stdout 纯文本会作为 SessionStart 附加上下文注入对话，让用户感知安装结果
    echo "loongsuite-pilot 已由插件自动安装完成：$STATUS"
    exit 0
else
    log "❌ installer 执行失败"
    echo "loongsuite-pilot 自动安装失败，详见 $LOG_FILE" >&2
    exit 1
fi
