#!/usr/bin/env bash
# loongsuite-pilot-installer 插件 SessionStart hook：
# 幂等检测并安装 loongsuite-pilot。node 依赖统一使用 v22.22.2：默认从
# NODE_DIST_BASE_URL（OSS）按平台下载，vendor/node 内有包则优先用本地包。
# 管理员参数从 config/install-params.conf 读取并透传给 installer。
# 用法：ensure-pilot.sh [--provision-node-only]（后者仅准备 node 并打印路径，供测试）
set -uo pipefail

PLUGIN_ROOT="${QODER_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${QODER_PLUGIN_DATA:-$HOME/.loongsuite-pilot-installer}"
LOG_FILE="$DATA_DIR/install.log"
LOCK_DIR="$DATA_DIR/install.lock"
PILOT_BIN="$HOME/.local/bin/loongsuite-pilot"

# ---- 内置默认值（可被 config/install-params.conf 及环境变量覆盖） ----
INSTALLER_URL="https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/installer.sh"
NODE_VERSION="22.22.2"
NODE_DIST_BASE_URL="https://taiye-test-sh.oss-cn-shanghai.aliyuncs.com/sensen-test"
NODE_MIN_MAJOR=22
INSTALL_ARGS=()

CONF="$PLUGIN_ROOT/config/install-params.conf"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

# 环境变量覆盖（管理员/用户级）
INSTALLER_URL="${LOONGSUITE_PILOT_INSTALLER_URL:-$INSTALLER_URL}"
NODE_DIST_BASE_URL="${LOONGSUITE_PILOT_NODE_DIST_BASE_URL:-$NODE_DIST_BASE_URL}"
# --user.id 追加覆盖：installer 顺序解析参数，后出现者生效
if [ -n "${LOONGSUITE_PILOT_USER_ID:-}" ]; then
    INSTALL_ARGS+=(--user.id "$LOONGSUITE_PILOT_USER_ID")
fi

mkdir -p "$DATA_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# ---- 平台检测（Windows 交由 ensure-pilot.ps1 处理，本脚本静默退出） ----
detect_platform() {
    local os arch
    case "$(uname -s)" in
        Darwin) os="darwin" ;;
        Linux)  os="linux" ;;
        MINGW*|MSYS*|CYGWIN*) os="win" ;;
        *) return 1 ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) arch="arm64" ;;
        x86_64|amd64)  arch="x64" ;;
        *) return 1 ;;
    esac
    echo "${os}-${arch}"
}

# Windows 下若本脚本被 Git Bash 拉起，直接让位给 PowerShell hook，避免重复安装
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) exit 0 ;;
esac

# ---- node >= 22 探测（本机已有则直接复用，不重复安装） ----
find_node() {
    local d major
    # 之前由本插件解包的捆绑 node
    for d in "$DATA_DIR/node"/node-v*/bin; do
        [ -x "$d/node" ] && { echo "$d"; return 0; }
    done
    for d in "$HOME/.nvm/versions/node"/*/bin; do
        [ -x "$d/node" ] || continue
        major=$(basename "$(dirname "$d")" | sed 's/^v//' | cut -d. -f1)
        [ "$major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null && { echo "$d"; return 0; }
    done
    if command -v node >/dev/null 2>&1; then
        major=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
        [ "$major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null && { dirname "$(command -v node)"; return 0; }
    fi
    return 1
}

# ---- 捆绑/下载 node 分发包并解压到插件数据目录 ----
provision_node() {
    local platform tarball vendor_tar dl_tar extract_dir
    platform=$(detect_platform) || { log "❌ 不支持的平台: $(uname -s)/$(uname -m)"; return 1; }
    tarball="node-v${NODE_VERSION}-${platform}.tar.gz"
    vendor_tar="$PLUGIN_ROOT/vendor/node/$tarball"
    extract_dir="$DATA_DIR/node"
    mkdir -p "$extract_dir"

    if [ -f "$vendor_tar" ]; then
        log "使用插件本地捆绑的 node 分发包: $tarball"
        dl_tar="$vendor_tar"
    else
        dl_tar="$DATA_DIR/$tarball"
        local url="$NODE_DIST_BASE_URL/$tarball"
        log "从 $url 下载 node 分发包"
        curl -fsSL "$url" -o "$dl_tar" 2>>"$LOG_FILE" || { log "❌ node 分发包下载失败: $url"; return 1; }
    fi

    tar -xzf "$dl_tar" -C "$extract_dir" 2>>"$LOG_FILE" || { log "❌ node 分发包解压失败"; return 1; }
    [ "$dl_tar" != "$vendor_tar" ] && rm -f "$dl_tar"
    echo "$extract_dir/node-v${NODE_VERSION}-${platform}/bin"
}

ensure_node() {
    local bin_dir
    if bin_dir=$(find_node); then
        log "node 环境就绪: $bin_dir"
    else
        log "未检测到 node >= $NODE_MIN_MAJOR，准备 node v$NODE_VERSION"
        bin_dir=$(provision_node) || return 1
        log "node 就绪: $bin_dir ($("$bin_dir/node" -v 2>/dev/null))"
    fi
    export PATH="$bin_dir:$HOME/.local/bin:$PATH"
}

# ---- 测试入口：仅准备 node ----
if [ "${1:-}" = "--provision-node-only" ]; then
    ensure_node || exit 1
    command -v node && node -v
    exit 0
fi

# ---- 参数指纹：installer 对 config.json 是合并语义（未传参数保留旧值），
# 因此参数变更时必须先 uninstall --purge 再重装，否则旧配置会残留 ----
FINGERPRINT_FILE="$DATA_DIR/install-args.sha256"

compute_fingerprint() {
    local payload
    payload="url=$INSTALLER_URL"$'\n'"$(printf '%s\n' ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"})"
    if command -v shasum >/dev/null 2>&1; then
        printf '%s' "$payload" | shasum -a 256 | awk '{print $1}'
    else
        printf '%s' "$payload" | sha256sum | awk '{print $1}'
    fi
}

CURRENT_FP=$(compute_fingerprint)

is_installed() {
    [ -x "$PILOT_BIN" ] || [ -x /usr/local/bin/loongsuite-pilot ]
}

fingerprint_matches() {
    [ -f "$FINGERPRINT_FILE" ] && [ "$(cat "$FINGERPRINT_FILE" 2>/dev/null)" = "$CURRENT_FP" ]
}

# ---- 幂等：已安装且参数未变则立即退出（每次会话启动都会触发本脚本） ----
if is_installed && fingerprint_matches; then
    exit 0
fi

# ---- 并发锁：多会话同时启动时只允许一个实例执行安装 ----
# CLI 退出可能杀掉 hook 进程导致锁残留，超过 TTL（15 分钟）的旧锁直接接管
if [ -d "$LOCK_DIR" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
    log "接管过期锁"
    rmdir "$LOCK_DIR" 2>/dev/null || true
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "另一实例正在安装，跳过"
    exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# 拿到锁后重新判定：可能另一实例已经装好了相同配置
if is_installed && fingerprint_matches; then
    exit 0
fi

# 参数变更：先卸载（含 --purge），避免旧 sls/cms 配置残留
NEED_REINSTALL=0
if is_installed; then
    NEED_REINSTALL=1
    log "已安装但参数指纹不一致，卸载后按新配置重装"
fi

log "installer: $INSTALLER_URL"
log "install args: ${INSTALL_ARGS[*]+${INSTALL_ARGS[*]}}"

ensure_node || {
    echo "loongsuite-pilot 自动安装失败：node 环境准备失败，详见 $LOG_FILE" >&2
    exit 1
}

# ---- 下载 installer（卸载与安装共用同一份） ----
INSTALLER_TMP="$DATA_DIR/installer.sh"
if ! curl -fsSL "$INSTALLER_URL" -o "$INSTALLER_TMP" 2>>"$LOG_FILE"; then
    log "❌ installer 下载失败: $INSTALLER_URL"
    echo "loongsuite-pilot 自动安装失败：installer 下载失败，详见 $LOG_FILE" >&2
    exit 1
fi

if [ "$NEED_REINSTALL" = "1" ]; then
    # stdin 必须接 /dev/null：installer 用 [ ! -t 0 ] 判非交互，而 hook 继承的 stdin
    # 不一定能让它走到非交互分支，一旦阻塞会直接碰 hook 超时（900s）
    if bash "$INSTALLER_TMP" uninstall --purge < /dev/null >> "$LOG_FILE" 2>&1; then
        log "旧版本已卸载"
    else
        log "⚠️ 卸载未完全成功，继续尝试安装（installer 会覆盖同名配置项）"
    fi
fi

if bash "$INSTALLER_TMP" install ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"} < /dev/null >> "$LOG_FILE" 2>&1; then
    printf '%s' "$CURRENT_FP" > "$FINGERPRINT_FILE"
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
