#!/usr/bin/env bash
# aac-installer.sh — Unified installer for ai-agent-collector
#
# Install (first time):
#   curl -fsSL <URL>/aac-installer.sh | bash
#   curl -fsSL <URL>/aac-installer.sh | bash -s -- install \
#     --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
#     --sls-project "my-project" \
#     --sls-logstore "my-logstore" \
#     --sls-ak-id "your-ak-id" \
#     --sls-ak-secret "your-ak-secret"
#
# Upgrade (preserve config, auto-rollback on failure):
#   curl -fsSL <URL>/aac-installer.sh | bash -s -- upgrade
#   curl -fsSL <URL>/aac-installer.sh | bash -s -- upgrade --package-url <url>
#
# Uninstall:
#   curl -fsSL <URL>/aac-installer.sh | bash -s -- uninstall
#   curl -fsSL <URL>/aac-installer.sh | bash -s -- uninstall --purge

set -euo pipefail

# ============================================================
# Constants
# ============================================================
DEFAULT_PACKAGE_URL="https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongcollector/ai-agent-collector/ai-agent-collector.tar.gz"
PACKAGE_NAME="ai-agent-collector"
PERMANENT_DIR="$HOME/.cache/ai-agent-collector/package"
BACKUP_DIR="$HOME/.cache/ai-agent-collector/package.bak"
DEFAULT_DATA_DIR="$HOME/.ai-agent-collector"

# ============================================================
# Parse sub-command
# ============================================================
COMMAND=""
PACKAGE_URL="${AAC_PACKAGE_URL:-$DEFAULT_PACKAGE_URL}"
SLS_ENDPOINT=""
SLS_PROJECT=""
SLS_LOGSTORE=""
SLS_AK_ID=""
SLS_AK_SECRET=""
DATA_DIR="$DEFAULT_DATA_DIR"
LOG_LEVEL=""
PURGE=0

# First arg is sub-command (or option -> default to install)
if [[ $# -gt 0 ]]; then
    case "$1" in
        install|upgrade|uninstall)
            COMMAND="$1"; shift ;;
        -*)
            COMMAND="install" ;;
        *)
            COMMAND="install" ;;
    esac
else
    COMMAND="install"
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --sls-endpoint)       SLS_ENDPOINT="$2"; shift 2 ;;
        --sls-endpoint=*)     SLS_ENDPOINT="${1#*=}"; shift ;;
        --sls-project)        SLS_PROJECT="$2"; shift 2 ;;
        --sls-project=*)      SLS_PROJECT="${1#*=}"; shift ;;
        --sls-logstore)       SLS_LOGSTORE="$2"; shift 2 ;;
        --sls-logstore=*)     SLS_LOGSTORE="${1#*=}"; shift ;;
        --sls-ak-id)          SLS_AK_ID="$2"; shift 2 ;;
        --sls-ak-id=*)        SLS_AK_ID="${1#*=}"; shift ;;
        --sls-ak-secret)      SLS_AK_SECRET="$2"; shift 2 ;;
        --sls-ak-secret=*)    SLS_AK_SECRET="${1#*=}"; shift ;;
        --package-url)        PACKAGE_URL="$2"; shift 2 ;;
        --package-url=*)      PACKAGE_URL="${1#--package-url=}"; shift ;;
        --data-dir)           DATA_DIR="$2"; shift 2 ;;
        --data-dir=*)         DATA_DIR="${1#*=}"; shift ;;
        --log-level)          LOG_LEVEL="$2"; shift 2 ;;
        --log-level=*)        LOG_LEVEL="${1#*=}"; shift ;;
        --lang)               export AAC_LANG="$2"; shift 2 ;;
        --lang=*)             export AAC_LANG="${1#--lang=}"; shift ;;
        --purge)              PURGE=1; shift ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1 ;;
    esac
done

# ============================================================
# Language detection
# ============================================================
detect_lang() {
    if [ -n "${AAC_LANG:-}" ]; then echo "$AAC_LANG"; return; fi
    for v in "${LANGUAGE:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
        if echo "$v" | grep -qi "zh"; then echo "zh"; return; fi
    done
    if [ "$(uname)" = "Darwin" ]; then
        local al
        al=$(defaults read -g AppleLanguages 2>/dev/null | grep -i "zh" | head -1 || true)
        if [ -n "$al" ]; then echo "zh"; return; fi
    fi
    echo "en"
}
LANG_MODE=$(detect_lang)
msg() { [ "$LANG_MODE" = "zh" ] && echo "$1" || echo "$2"; }

# ============================================================
# Common: check dependencies
# ============================================================
check_deps() {
    msg "==> 检查依赖..." "==> Checking dependencies..."

    for cmd in node npm; do
        if ! command -v "$cmd" &>/dev/null; then
            msg "❌ 缺少依赖: $cmd，请先安装后重试" \
                "❌ Missing dependency: $cmd — please install it first"
            exit 1
        fi
    done

    NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
    if [ "$NODE_MAJOR" -lt 18 ]; then
        msg "❌ 需要 Node.js >= 18，当前版本: $(node --version)" \
            "❌ Requires Node.js >= 18, current: $(node --version)"
        exit 1
    fi

    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        msg "❌ 需要 curl 或 wget，请先安装" \
            "❌ curl or wget is required — please install one first"
        exit 1
    fi

    msg "    ✅ node $(node --version)  npm $(npm --version)" \
        "    ✅ node $(node --version)  npm $(npm --version)"
    echo ""
}

# ============================================================
# Common: download and extract package -> sets INSTALL_SRC
# ============================================================
download_and_extract() {
    TMP_DIR="$(mktemp -d)"
    # TMP_DIR cleanup is handled by the caller's trap

    msg "📦 下载安装包: $PACKAGE_URL" \
        "📦 Downloading: $PACKAGE_URL"

    if command -v curl &>/dev/null; then
        curl -fsSL "$PACKAGE_URL" -o "$TMP_DIR/package.tar.gz"
    else
        wget -q "$PACKAGE_URL" -O "$TMP_DIR/package.tar.gz"
    fi
    msg "    ✅ 下载完成" "    ✅ Downloaded"
    echo ""

    msg "==> 解压安装包..." "==> Extracting..."
    if tar --warning=no-unknown-keyword -xzf "$TMP_DIR/package.tar.gz" -C "$TMP_DIR" 2>/dev/null; then
        :
    else
        tar -xzf "$TMP_DIR/package.tar.gz" -C "$TMP_DIR"
    fi

    if [ -d "$TMP_DIR/$PACKAGE_NAME" ]; then
        INSTALL_SRC="$TMP_DIR/$PACKAGE_NAME"
    elif [ -f "$TMP_DIR/package.json" ]; then
        INSTALL_SRC="$TMP_DIR"
    else
        INSTALL_SRC=$(find "$TMP_DIR" -name "package.json" -maxdepth 2 -exec dirname {} \; | head -1 || true)
        if [ -z "$INSTALL_SRC" ]; then
            msg "❌ 解压后未找到 package.json，安装包结构异常" \
                "❌ package.json not found — unexpected package structure"
            exit 1
        fi
    fi
    msg "    ✅ 解压完成" "    ✅ Extracted"
    echo ""
}

# ============================================================
# Common: deploy package files to PERMANENT_DIR
# ============================================================
deploy_package() {
    local src="$1"

    msg "==> 部署到 $PERMANENT_DIR ..." \
        "==> Deploying to $PERMANENT_DIR ..."
    mkdir -p "$(dirname "$PERMANENT_DIR")"
    rm -rf "$PERMANENT_DIR"
    cp -r "$src" "$PERMANENT_DIR"
    msg "    ✅ 部署完成" "    ✅ Deployed"
    echo ""

    msg "==> 安装依赖..." "==> Installing dependencies..."
    cd "$PERMANENT_DIR"
    npm install --production --no-optional 2>&1 | tail -1
    msg "    ✅ 依赖安装完成" "    ✅ Dependencies installed"
    echo ""

    msg "==> 部署 hook 脚本..." "==> Deploying hook scripts..."
    if [ -f scripts/postinstall.js ]; then
        node scripts/postinstall.js
    fi
    msg "    ✅ Hook 脚本已部署" "    ✅ Hook scripts deployed"
    echo ""
}

# ============================================================
# Common: write / merge config.json
# ============================================================
write_config() {
    local config_file="$DATA_DIR/config.json"
    msg "==> 写入配置文件 $config_file ..." \
        "==> Writing config to $config_file ..."
    mkdir -p "$DATA_DIR"

    node -e "
const fs = require('fs');
const path = '$config_file';

let existing = {};
try { existing = JSON.parse(fs.readFileSync(path, 'utf-8')); } catch {}

const config = {
  ...existing,
  enabled: true,
  dataDir: '$DATA_DIR',
};

const slsEndpoint = '${SLS_ENDPOINT}';
const slsProject  = '${SLS_PROJECT}';
const slsLogstore = '${SLS_LOGSTORE}';
const slsAkId     = '${SLS_AK_ID}';
const slsAkSecret = '${SLS_AK_SECRET}';
const logLevel    = '${LOG_LEVEL}';

if (slsEndpoint) {
  config.sls = config.sls || {};
  config.sls.endpoint = slsEndpoint;
  if (slsAkId && slsAkSecret) {
    config.sls.mode = 'ak';
    config.sls.accessKeyId = slsAkId;
    config.sls.accessKeySecret = slsAkSecret;
  }
  if (slsProject && slsLogstore) {
    config.sls.endpoints = config.sls.endpoints || [];
    const exists = config.sls.endpoints.some(
      e => e.project === slsProject && e.logstore === slsLogstore
    );
    if (!exists) {
      config.sls.endpoints.push({
        name: 'agent-activity',
        project: slsProject,
        logstore: slsLogstore,
        kind: 'agentActivity'
      });
    }
  }
}

if (logLevel) {
  config.logLevel = logLevel;
}

fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
"
    msg "    ✅ 配置已写入" "    ✅ Config written"
    echo ""
}

# ============================================================
# Common: install/update the aac service management script
# ============================================================
install_aac_command() {
    msg "==> 安装服务管理脚本..." "==> Installing service management script..."
    local global_bin_dir="$HOME/.local/bin"
    mkdir -p "$global_bin_dir"

    local aac_cmd="$global_bin_dir/aac"

    cat > "$aac_cmd" << 'SERVICEEOF'
#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${AAC_DATA_DIR:-$HOME/.ai-agent-collector}"
PACKAGE_DIR="$HOME/.cache/ai-agent-collector/package"
ENTRY_POINT="$PACKAGE_DIR/dist/index.js"
PID_FILE="$DATA_DIR/aac.pid"
LOG_DIR="$DATA_DIR/logs"
LOG_FILE="$LOG_DIR/aac-service.log"
CONFIG_FILE="$DATA_DIR/config.json"

ensure_dirs() {
    mkdir -p "$LOG_DIR"
}

is_running() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        rm -f "$PID_FILE"
    fi
    return 1
}

cmd_start() {
    if is_running; then
        echo "ai-agent-collector is already running (PID $(cat "$PID_FILE"))"
        return 0
    fi
    ensure_dirs

    if [ ! -f "$ENTRY_POINT" ]; then
        echo "❌ Entry point not found: $ENTRY_POINT"
        exit 1
    fi

    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
    nohup node "$ENTRY_POINT" >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    echo "✅ ai-agent-collector started (PID $pid)"
    echo "   Log: $LOG_FILE"
    echo "   Config: $CONFIG_FILE"
}

cmd_stop() {
    if ! is_running; then
        echo "ai-agent-collector is not running"
        return 0
    fi
    local pid
    pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null || true

    local count=0
    while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
        sleep 1
        count=$((count + 1))
    done

    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
    fi

    rm -f "$PID_FILE"
    echo "✅ ai-agent-collector stopped"
}

cmd_restart() {
    cmd_stop
    cmd_start
}

cmd_status() {
    local ver_info=""
    local version_file="$PACKAGE_DIR/VERSION"
    if [ -f "$version_file" ]; then
        local v; v=$(grep '^version=' "$version_file" | cut -d= -f2)
        local c; c=$(grep '^git_commit=' "$version_file" | cut -d= -f2)
        ver_info=" v${v} (${c})"
    fi

    if is_running; then
        local pid
        pid=$(cat "$PID_FILE")
        echo "✅ ai-agent-collector${ver_info} is running (PID $pid)"
        echo "   Config: $CONFIG_FILE"
        echo "   Log:    $LOG_FILE"
        echo "   Data:   $DATA_DIR"
    else
        echo "⚪ ai-agent-collector${ver_info} is not running"
    fi
}

cmd_version() {
    local version_file="$PACKAGE_DIR/VERSION"
    if [ -f "$version_file" ]; then
        cat "$version_file"
    else
        echo "Version info not available"
    fi
}

cmd_log() {
    if [ -f "$LOG_FILE" ]; then
        tail -f "$LOG_FILE"
    else
        echo "No log file found: $LOG_FILE"
    fi
}

cmd_config() {
    if [ -f "$CONFIG_FILE" ]; then
        echo "Config file: $CONFIG_FILE"
        echo "---"
        cat "$CONFIG_FILE"
    else
        echo "No config file found: $CONFIG_FILE"
    fi
}

cmd_help() {
    cat << 'HELP'
Usage: aac <command>

Commands:
  start     Start the collector service (background)
  stop      Stop the collector service
  restart   Restart the collector service
  status    Show whether the service is running
  log       Tail the service log (Ctrl+C to stop)
  config    Show the current config file
  version   Show version information
  help      Show this help message
HELP
}

case "${1:-help}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    log)     cmd_log ;;
    config)  cmd_config ;;
    version|--version|-v) cmd_version ;;
    help|--help|-h) cmd_help ;;
    *)
        echo "Unknown command: $1"
        cmd_help
        exit 1 ;;
esac
SERVICEEOF

    chmod +x "$aac_cmd"
    msg "    ✅ 已安装: $aac_cmd" "    ✅ Installed: $aac_cmd"

    # If /usr/local/bin is writable (root), create a symlink for immediate PATH access
    if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
        ln -sf "$aac_cmd" /usr/local/bin/aac
        msg "    ✅ 已链接到 /usr/local/bin/aac" "    ✅ Linked to /usr/local/bin/aac"
    else
        ensure_path_block() {
            local file="$1"
            if [ ! -f "$file" ]; then
                touch "$file"
            fi
            if grep -q '\.local/bin' "$file" 2>/dev/null; then return 0; fi
            cat >> "$file" << 'PATHBLOCK'

# ai-agent-collector: add ~/.local/bin to PATH
export PATH="$HOME/.local/bin:$PATH"
PATHBLOCK
            msg "    已将 ~/.local/bin 添加到 PATH ($file)" \
                "    Added ~/.local/bin to PATH ($file)"
        }

        case "${SHELL:-/bin/bash}" in
            */zsh)
                ensure_path_block "$HOME/.zshrc" || true
                ;;
            */bash)
                ensure_path_block "$HOME/.bashrc" || true
                ensure_path_block "$HOME/.bash_profile" || true
                ;;
            *)
                ensure_path_block "$HOME/.bashrc" || true
                ;;
        esac
    fi
    echo ""

    # Ensure aac is on PATH for the rest of this script
    export PATH="$global_bin_dir:$PATH"
}

# ============================================================
# Common: read VERSION file fields
# ============================================================
get_installed_version() {
    local vf="$PERMANENT_DIR/VERSION"
    if [ -f "$vf" ]; then
        grep '^version=' "$vf" | cut -d= -f2
    else
        echo ""
    fi
}

get_version_from_dir() {
    local vf="$1/VERSION"
    if [ -f "$vf" ]; then
        grep '^version=' "$vf" | cut -d= -f2
    else
        echo ""
    fi
}

get_commit_from_dir() {
    local vf="$1/VERSION"
    if [ -f "$vf" ]; then
        grep '^git_commit=' "$vf" | cut -d= -f2
    else
        echo ""
    fi
}

show_version_info() {
    local dir="$1"
    local vf="$dir/VERSION"
    if [ -f "$vf" ]; then
        local v; v=$(grep '^version=' "$vf" | cut -d= -f2)
        local c; c=$(grep '^git_commit=' "$vf" | cut -d= -f2)
        local t; t=$(grep '^build_time=' "$vf" | cut -d= -f2)
        echo "v${v} (${c}, ${t})"
    else
        echo "unknown"
    fi
}

# ============================================================
# Common: print summary
# ============================================================
print_summary() {
    local action="$1"  # install / upgrade
    local config_file="$DATA_DIR/config.json"
    echo "============================================================"
    local ver; ver=$(show_version_info "$PERMANENT_DIR")
    case "$action" in
        install)
            msg "✅ 安装完成！版本: $ver" "✅ Installation complete! Version: $ver" ;;
        upgrade)
            msg "✅ 升级完成！版本: $ver" "✅ Upgrade complete! Version: $ver" ;;
    esac
    echo ""
    msg "配置文件: $config_file" "Config file: $config_file"
    msg "数据目录: $DATA_DIR" "Data directory: $DATA_DIR"
    msg "Hook 目录: $DATA_DIR/hooks" "Hooks directory: $DATA_DIR/hooks"
    echo ""

    if [ -n "$SLS_ENDPOINT" ]; then
        msg "📊 SLS 后端: $SLS_ENDPOINT" "📊 SLS backend: $SLS_ENDPOINT"
        [ -n "$SLS_PROJECT" ]  && msg "   项目: $SLS_PROJECT" "   Project: $SLS_PROJECT"
        [ -n "$SLS_LOGSTORE" ] && msg "   日志库: $SLS_LOGSTORE" "   Logstore: $SLS_LOGSTORE"
        echo ""
    fi

    msg "服务管理命令:" "Service management:"
    echo "   aac start      # 启动服务 / Start"
    echo "   aac stop       # 停止服务 / Stop"
    echo "   aac restart    # 重启服务 / Restart"
    echo "   aac status     # 查看状态 / Status"
    echo "   aac log        # 查看日志 / Tail log"
    echo "   aac config     # 查看配置 / Show config"
    echo "============================================================"
}

# ============================================================
# CMD: install
# ============================================================
cmd_install() {
    msg "🚀 开始安装 $PACKAGE_NAME ..." \
        "🚀 Installing $PACKAGE_NAME ..."
    echo ""

    check_deps

    # Check if already installed
    if [ -d "$PERMANENT_DIR" ] && [ -f "$PERMANENT_DIR/dist/index.js" ]; then
        local cur_ver; cur_ver=$(get_installed_version)
        if [ -n "$cur_ver" ]; then
            msg "⚠️  检测到已安装版本 v${cur_ver}，将执行重新安装" \
                "⚠️  Existing installation v${cur_ver} detected, re-installing"
            echo ""
        fi
    fi

    trap 'rm -rf "${TMP_DIR:-}"' EXIT
    download_and_extract
    deploy_package "$INSTALL_SRC"
    write_config
    install_aac_command

    msg "==> 启动服务..." "==> Starting service..."
    if aac start; then
        :
    else
        msg "    ⚠️  服务启动失败，请手动运行: aac start" \
            "    ⚠️  Service failed to start, run manually: aac start"
    fi
    echo ""

    print_summary "install"
}

# ============================================================
# CMD: upgrade
# ============================================================
cmd_upgrade() {
    msg "🔄 开始升级 $PACKAGE_NAME ..." \
        "🔄 Upgrading $PACKAGE_NAME ..."
    echo ""

    # Must have an existing installation
    if [ ! -d "$PERMANENT_DIR" ] || [ ! -f "$PERMANENT_DIR/dist/index.js" ]; then
        msg "❌ 未检测到已安装的 ai-agent-collector，请先执行 install" \
            "❌ No existing installation found. Please run install first."
        exit 1
    fi

    local old_ver; old_ver=$(get_installed_version)
    msg "   当前版本: ${old_ver:-unknown}" "   Current version: ${old_ver:-unknown}"
    echo ""

    check_deps

    trap 'rm -rf "${TMP_DIR:-}"' EXIT
    download_and_extract

    # Compare versions (version + git_commit together determine identity)
    local new_ver; new_ver=$(get_version_from_dir "$INSTALL_SRC")
    local new_commit; new_commit=$(get_commit_from_dir "$INSTALL_SRC")
    local old_commit; old_commit=$(get_commit_from_dir "$PERMANENT_DIR")

    if [ -n "$new_ver" ] && [ "$new_ver" = "$old_ver" ] && [ "$new_commit" = "$old_commit" ]; then
        msg "✅ 已是最新版本 v${new_ver} (${new_commit})，无需升级" \
            "✅ Already at latest version v${new_ver} (${new_commit}), nothing to do"
        exit 0
    fi

    msg "   新版本: ${new_ver:-unknown} (${new_commit:-unknown})" \
        "   New version: ${new_ver:-unknown} (${new_commit:-unknown})"
    echo ""

    # Stop the running service
    msg "==> 停止服务..." "==> Stopping service..."
    if command -v aac &>/dev/null; then
        aac stop 2>/dev/null || true
    elif [ -f "$HOME/.local/bin/aac" ]; then
        "$HOME/.local/bin/aac" stop 2>/dev/null || true
    fi
    echo ""

    # Backup the old package
    msg "==> 备份旧版本..." "==> Backing up old version..."
    rm -rf "$BACKUP_DIR"
    cp -r "$PERMANENT_DIR" "$BACKUP_DIR"
    msg "    ✅ 已备份到 $BACKUP_DIR" "    ✅ Backed up to $BACKUP_DIR"
    echo ""

    # Deploy the new package
    deploy_package "$INSTALL_SRC"
    install_aac_command

    # Start the new version
    msg "==> 启动新版本..." "==> Starting new version..."
    if aac start; then
        # Wait a moment and verify the process is alive
        sleep 2
        if aac status 2>/dev/null | grep -q "is running"; then
            msg "    ✅ 新版本启动成功" "    ✅ New version started successfully"
            echo ""

            # Cleanup backup
            rm -rf "$BACKUP_DIR"

            print_summary "upgrade"
            return 0
        fi
    fi

    # --- Rollback ---
    echo ""
    msg "⚠️  新版本启动失败，正在回滚..." \
        "⚠️  New version failed to start, rolling back..."

    # Stop whatever might have partially started
    aac stop 2>/dev/null || true

    # Restore old package
    rm -rf "$PERMANENT_DIR"
    mv "$BACKUP_DIR" "$PERMANENT_DIR"
    msg "    ✅ 已恢复旧版本" "    ✅ Old version restored"

    # Restart old version
    aac start 2>/dev/null || true
    msg "    ✅ 旧版本已重新启动" "    ✅ Old version restarted"
    echo ""

    msg "❌ 升级失败，已回滚到 v${old_ver:-unknown}" \
        "❌ Upgrade failed, rolled back to v${old_ver:-unknown}"
    msg "   请检查日志: aac log" "   Check logs: aac log"
    exit 1
}

# ============================================================
# CMD: uninstall
# ============================================================
cmd_uninstall() {
    msg "🗑️  开始卸载 $PACKAGE_NAME ..." \
        "🗑️  Uninstalling $PACKAGE_NAME ..."
    echo ""

    # Stop the service
    msg "==> 停止服务..." "==> Stopping service..."
    if command -v aac &>/dev/null; then
        aac stop 2>/dev/null || true
    elif [ -f "$HOME/.local/bin/aac" ]; then
        "$HOME/.local/bin/aac" stop 2>/dev/null || true
    else
        # Try to kill by PID file directly
        local pid_file="$DATA_DIR/aac.pid"
        if [ -f "$pid_file" ]; then
            local pid; pid=$(cat "$pid_file")
            kill "$pid" 2>/dev/null || true
            sleep 2
            kill -9 "$pid" 2>/dev/null || true
            rm -f "$pid_file"
        fi
    fi
    msg "    ✅ 服务已停止" "    ✅ Service stopped"
    echo ""

    # Remove package directory
    msg "==> 删除安装目录..." "==> Removing installation..."
    rm -rf "$HOME/.cache/ai-agent-collector"
    msg "    ✅ 已删除 $HOME/.cache/ai-agent-collector" \
        "    ✅ Removed $HOME/.cache/ai-agent-collector"

    # Remove aac command
    msg "==> 删除 aac 命令..." "==> Removing aac command..."
    rm -f "$HOME/.local/bin/aac"
    rm -f /usr/local/bin/aac 2>/dev/null || true
    msg "    ✅ aac 命令已删除" "    ✅ aac command removed"
    echo ""

    # Data directory
    if [ "$PURGE" -eq 1 ]; then
        msg "==> 删除数据目录 (--purge)..." "==> Removing data directory (--purge)..."
        rm -rf "$DATA_DIR"
        msg "    ✅ 已删除 $DATA_DIR" "    ✅ Removed $DATA_DIR"
    else
        msg "📁 数据目录已保留: $DATA_DIR" \
            "📁 Data directory preserved: $DATA_DIR"
        msg "   (包含配置和日志，如需彻底删除请加 --purge)" \
            "   (contains config and logs, add --purge to remove)"
    fi
    echo ""

    echo "============================================================"
    msg "✅ 卸载完成！" "✅ Uninstallation complete!"
    echo "============================================================"
}

# ============================================================
# Main dispatcher
# ============================================================
case "$COMMAND" in
    install)   cmd_install ;;
    upgrade)   cmd_upgrade ;;
    uninstall) cmd_uninstall ;;
    *)
        echo "Usage: $0 {install|upgrade|uninstall} [options]"
        exit 1 ;;
esac
