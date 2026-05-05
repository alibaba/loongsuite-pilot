#!/usr/bin/env bash
# loongpilot-installer.sh — Unified installer for loongsuite-pilot
#
# Install (first time):
#   curl -fsSL <URL>/loongpilot-installer.sh | bash
#   curl -fsSL <URL>/loongpilot-installer.sh | bash -s -- install \
#     --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
#     --sls-project "my-project" \
#     --sls-logstore "my-logstore" \
#     --sls-ak-id "your-ak-id" \
#     --sls-ak-secret "your-ak-secret"
#
# Install from test channel:
#   curl -fsSL <URL>/loongpilot-installer.sh | bash -s -- install --channel test
#
# Upgrade (preserve config, auto-rollback on failure):
#   curl -fsSL <URL>/loongpilot-installer.sh | bash -s -- upgrade
#   curl -fsSL <URL>/loongpilot-installer.sh | bash -s -- upgrade --package-url <url>
#
# Uninstall:
#   curl -fsSL <URL>/loongpilot-installer.sh | bash -s -- uninstall
#   curl -fsSL <URL>/loongpilot-installer.sh | bash -s -- uninstall --purge

set -euo pipefail

# ============================================================
# Constants
# ============================================================
PACKAGE_NAME="loongsuite-pilot"
PERMANENT_DIR="$HOME/.loongsuite-pilot/package"
DEFAULT_DATA_DIR="$HOME/.loongsuite-pilot"
OTEL_PLUGIN_INSTALL_URL="https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-claude/remote-install.sh"
OTEL_CLAUDE_DIR="$HOME/.cache/opentelemetry.instrumentation.claude"
OTEL_CODEX_PLUGIN_INSTALL_URL="https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-codex/remote-install.sh"
OTEL_CODEX_DIR="$HOME/.cache/opentelemetry.instrumentation.codex"

# Channel presets: release (production) vs test (pre-release)
_RELEASE_BASE_URL="https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot"
_TEST_BASE_URL="https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-dev/loongsuite-pilot"

# ============================================================
# Parse sub-command
# ============================================================
COMMAND=""
CHANNEL="${LOONGPILOT_CHANNEL:-release}"
PACKAGE_URL="${LOONGPILOT_PACKAGE_URL:-}"
INSTALL_VERSION=""
SLS_ENDPOINT="https://cn-heyuan.log.aliyuncs.com"
SLS_PROJECT="ai-coding-devops"
SLS_LOGSTORE="ai-coding-test"
SLS_AK_ID=""
SLS_AK_SECRET=""
DATA_DIR="$DEFAULT_DATA_DIR"
LOG_LEVEL=""
USER_ID=""
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
        --user.id)            USER_ID="$2"; shift 2 ;;
        --user.id=*)          USER_ID="${1#*=}"; shift ;;
        --lang)               export LOONGPILOT_LANG="$2"; shift 2 ;;
        --lang=*)             export LOONGPILOT_LANG="${1#--lang=}"; shift ;;
        --version)            INSTALL_VERSION="$2"; shift 2 ;;
        --version=*)          INSTALL_VERSION="${1#*=}"; shift ;;
        --channel)            CHANNEL="$2"; shift 2 ;;
        --channel=*)          CHANNEL="${1#*=}"; shift ;;
        --purge)              PURGE=1; shift ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1 ;;
    esac
done

# Resolve PACKAGE_URL from channel + version if not explicitly set
if [ -z "$PACKAGE_URL" ]; then
    _channel_base=""
    case "$CHANNEL" in
        release|prod)
            _channel_base="$_RELEASE_BASE_URL" ;;
        test|pre)
            _channel_base="$_TEST_BASE_URL" ;;
        *)
            echo "❌ Unknown channel: $CHANNEL (use 'release' or 'test')" >&2
            exit 1 ;;
    esac
    if [ -n "$INSTALL_VERSION" ]; then
        PACKAGE_URL="${_channel_base}/${INSTALL_VERSION}/${PACKAGE_NAME}.tar.gz"
    else
        PACKAGE_URL="${_channel_base}/latest/${PACKAGE_NAME}.tar.gz"
    fi
    # Auto-update always checks latest, not a pinned version
    UPDATE_PACKAGE_URL="${_channel_base}/latest/${PACKAGE_NAME}.tar.gz"
else
    # Explicit --package-url: use as-is for both download and auto-update
    UPDATE_PACKAGE_URL="$PACKAGE_URL"
fi

# ============================================================
# Language detection
# ============================================================
detect_lang() {
    if [ -n "${LOONGPILOT_LANG:-}" ]; then echo "$LOONGPILOT_LANG"; return; fi
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
# Common: deploy bootstrap scripts from the current version
# ============================================================
deploy_bootstrap_scripts() {
    local src_dir="$PERMANENT_DIR/scripts"
    local boot_dir="$HOME/.loongsuite-pilot/bin"
    mkdir -p "$boot_dir"
    cp -f "$src_dir/collector-daemon.js" "$boot_dir/"
    cp -f "$src_dir/updater-daemon.js"   "$boot_dir/"
}

# ============================================================
# Common: deploy package to versions/ directory
# ============================================================
deploy_package() {
    local src="$1"
    local cache_dir="$HOME/.loongsuite-pilot"
    local versions_dir="$cache_dir/versions"
    local current_file="$cache_dir/current"
    local previous_file="$cache_dir/previous"

    local ver="" commit=""
    if [ -f "$src/VERSION" ]; then
        ver=$(grep '^version=' "$src/VERSION" | cut -d= -f2)
        commit=$(grep '^git_commit=' "$src/VERSION" | cut -d= -f2)
    fi

    if [ -n "$ver" ] && [ -n "$commit" ]; then
        local dir_name="${ver}_${commit}"
        local target="$versions_dir/$dir_name"

        if [ -f "$current_file" ]; then
            local old_dir
            old_dir=$(cat "$current_file" 2>/dev/null | tr -d '[:space:]')
            if [ -n "$old_dir" ] && [ "$old_dir" != "$dir_name" ]; then
                echo "$old_dir" > "$previous_file"
            fi
        fi

        msg "==> 部署到 $target ..." "==> Deploying to $target ..."
        mkdir -p "$versions_dir"
        rm -rf "$target"
        cp -r "$src" "$target"

        echo "$dir_name" > "$current_file.tmp"
        mv -f "$current_file.tmp" "$current_file"

        PERMANENT_DIR="$target"
    else
        msg "==> 部署到 $PERMANENT_DIR ..." \
            "==> Deploying to $PERMANENT_DIR ..."
        mkdir -p "$(dirname "$PERMANENT_DIR")"
        rm -rf "$PERMANENT_DIR"
        cp -r "$src" "$PERMANENT_DIR"
    fi
    msg "    ✅ 部署完成" "    ✅ Deployed"
    echo ""

    deploy_bootstrap_scripts

    msg "==> 安装依赖..." "==> Installing dependencies..."
    (cd "$PERMANENT_DIR" && npm install --production --no-optional 2>&1 | tail -1)
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
# Migrate legacy single-directory layout to versions/ layout
# ============================================================
migrate_legacy_layout() {
    local cache_dir="$HOME/.loongsuite-pilot"
    local current_file="$cache_dir/current"
    local legacy_dir="$cache_dir/package"
    local versions_dir="$cache_dir/versions"

    if [ -f "$current_file" ]; then
        return 0
    fi
    if [ ! -d "$legacy_dir" ] || [ ! -f "$legacy_dir/dist/index.js" ]; then
        return 0
    fi

    msg "==> 迁移旧版本目录结构..." "==> Migrating legacy directory layout..."

    local ver="" commit=""
    if [ -f "$legacy_dir/VERSION" ]; then
        ver=$(grep '^version=' "$legacy_dir/VERSION" | cut -d= -f2)
        commit=$(grep '^git_commit=' "$legacy_dir/VERSION" | cut -d= -f2)
    fi
    ver="${ver:-0.0.0}"
    commit="${commit:-legacy}"

    local dir_name="${ver}_${commit}"
    local target="$versions_dir/$dir_name"

    mkdir -p "$versions_dir"
    cp -r "$legacy_dir" "$target"
    echo "$dir_name" > "$current_file"

    PERMANENT_DIR="$target"
    msg "    ✅ 已迁移到 $target" "    ✅ Migrated to $target"
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
const userId      = '${USER_ID}';

if (slsEndpoint) {
  config.sls = config.sls || {};
  config.sls.endpoint = slsEndpoint;
  if (slsAkId && slsAkSecret) {
    config.sls.mode = 'ak';
    config.sls.accessKeyId = slsAkId;
    config.sls.accessKeySecret = slsAkSecret;
  }
  if (slsProject && slsLogstore) {
    config.sls.project = slsProject;
    config.sls.logstore = slsLogstore;
    delete config.sls.endpoints;
  }
}

if (logLevel) {
  config.logLevel = logLevel;
}

if (userId) {
  config['user.id'] = userId;
  delete config.identity;
}

const updateUrl = '${UPDATE_PACKAGE_URL}';
if (updateUrl) {
  config.autoUpdate = config.autoUpdate || {};
  config.autoUpdate.packageUrl = updateUrl;
}

fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
"
    msg "    ✅ 配置已写入" "    ✅ Config written"
    echo ""
}

# ============================================================
# Common: install/update the loongpilot service management script
# ============================================================
install_loongpilot_command() {
    msg "==> 安装服务管理脚本..." "==> Installing service management script..."
    local global_bin_dir="$HOME/.local/bin"
    mkdir -p "$global_bin_dir"

    local loongpilot_cmd="$global_bin_dir/loongpilot"
    cp -f "$PERMANENT_DIR/scripts/loongpilot.sh" "$loongpilot_cmd"
    chmod +x "$loongpilot_cmd"
    msg "    ✅ 已安装: $loongpilot_cmd" "    ✅ Installed: $loongpilot_cmd"

    # If /usr/local/bin is writable (root), create a symlink for immediate PATH access
    if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
        ln -sf "$loongpilot_cmd" /usr/local/bin/loongpilot
        msg "    ✅ 已链接到 /usr/local/bin/loongpilot" "    ✅ Linked to /usr/local/bin/loongpilot"
    else
        ensure_path_block() {
            local file="$1"
            if [ ! -f "$file" ]; then
                touch "$file"
            fi
            if grep -q '\.local/bin' "$file" 2>/dev/null; then return 0; fi
            cat >> "$file" << 'PATHBLOCK'

# loongsuite-pilot: add ~/.local/bin to PATH
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

    # Ensure loongpilot is on PATH for the rest of this script
    export PATH="$global_bin_dir:$PATH"
}

# ============================================================
# Common: read VERSION file fields
# ============================================================
get_installed_version() {
    local cache_dir="$HOME/.loongsuite-pilot"
    local current_file="$cache_dir/current"
    local versions_dir="$cache_dir/versions"

    if [ -f "$current_file" ]; then
        local dir
        dir=$(cat "$current_file" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$dir" ] && [ -f "$versions_dir/$dir/VERSION" ]; then
            grep '^version=' "$versions_dir/$dir/VERSION" | cut -d= -f2
            return 0
        fi
    fi

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
# ============================================================
# Install OTel Claude plugin (log-only mode for loongpilot integration)
# ============================================================
install_otel_plugin() {
    local OTEL_LOG_DIR="$DATA_DIR/logs/claude-code"

    msg "==> 安装 Claude Code OTel 插件 (log-only 模式)..." \
        "==> Installing Claude Code OTel plugin (log-only mode)..."

    if [ -f "$OTEL_CLAUDE_DIR/package/src/cli.js" ]; then
        msg "    ✅ OTel 插件已存在，跳过下载安装" \
            "    ✅ OTel plugin already installed, skipping download"
    else
        if curl -fsSL "$OTEL_PLUGIN_INSTALL_URL" | bash; then
            msg "    ✅ OTel 插件安装完成" "    ✅ OTel plugin installed"
        else
            msg "    ⚠️  OTel 插件安装失败（不影响 loongpilot 其他功能）" \
                "    ⚠️  OTel plugin installation failed (non-blocking for loongpilot)"
            return 0
        fi
    fi

    local otel_config="$HOME/.claude/otel-config.json"
    mkdir -p "$(dirname "$otel_config")"

    node -e "
const fs = require('fs');
const cfgPath = process.argv[1];
const logDir = process.argv[2];

let existing = {};
try { existing = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch {}

existing.log_enabled = true;
if (existing.log_dir === undefined || existing.log_dir === '') existing.log_dir = logDir;
if (existing.log_filename_format === undefined) existing.log_filename_format = 'hook';

fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
" "$otel_config" "$OTEL_LOG_DIR"

    msg "    ✅ otel-config.json 已写入 (log_enabled=true, log_filename_format=hook)" \
        "    ✅ otel-config.json written (log_enabled=true, log_filename_format=hook)"

    mkdir -p "$OTEL_LOG_DIR"
    echo ""

    # --- Codex OTel plugin ---
    if command -v codex &>/dev/null; then
        local CODEX_LOG_DIR="$DATA_DIR/logs/codex"

        msg "==> 安装 Codex OTel 插件 (log-only 模式)..." \
            "==> Installing Codex OTel plugin (log-only mode)..."

        if [ -f "$OTEL_CODEX_DIR/package/dist/index.js" ]; then
            msg "    ✅ Codex OTel 插件已存在，跳过下载安装" \
                "    ✅ Codex OTel plugin already installed, skipping download"
        else
            if curl -fsSL "$OTEL_CODEX_PLUGIN_INSTALL_URL" | bash; then
                msg "    ✅ Codex OTel 插件安装完成" "    ✅ Codex OTel plugin installed"
            else
                msg "    ⚠️  Codex OTel 插件安装失败（不影响 loongpilot 其他功能）" \
                    "    ⚠️  Codex OTel plugin installation failed (non-blocking for loongpilot)"
            fi
        fi

        local codex_otel_config="$HOME/.codex/otel-config.json"
        mkdir -p "$(dirname "$codex_otel_config")"

        node -e "
const fs = require('fs');
const cfgPath = process.argv[1];
const logDir = process.argv[2];

let existing = {};
try { existing = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch {}

existing.log_enabled = true;
if (existing.log_dir === undefined || existing.log_dir === '') existing.log_dir = logDir;
if (existing.log_filename_format === undefined) existing.log_filename_format = 'hook';

fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
" "$codex_otel_config" "$CODEX_LOG_DIR"

        msg "    ✅ ~/.codex/otel-config.json 已写入 (log_enabled=true, log_filename_format=hook)" \
            "    ✅ ~/.codex/otel-config.json written (log_enabled=true, log_filename_format=hook)"

        mkdir -p "$CODEX_LOG_DIR"
        echo ""
    else
        msg "    ℹ️  未检测到 codex CLI，跳过 Codex OTel 插件安装" \
            "    ℹ️  codex CLI not found, skipping Codex OTel plugin installation"
        echo ""
    fi
}

# ============================================================
# Remove OTel Claude plugin
# ============================================================
remove_otel_plugin() {
    if [ -f "$OTEL_CLAUDE_DIR/package/scripts/uninstall.sh" ]; then
        bash "$OTEL_CLAUDE_DIR/package/scripts/uninstall.sh" 2>/dev/null || true
        msg "    ✅ OTel 插件 hooks 和 alias 已清理" \
            "    ✅ OTel plugin hooks and alias cleaned"
    else
        for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile"; do
            [ -f "$rc" ] || continue
            if grep -q "# BEGIN otel-claude-hook" "$rc" 2>/dev/null; then
                sed -i.bak '/# BEGIN otel-claude-hook/,/# END otel-claude-hook/d' "$rc"
                rm -f "${rc}.bak"
            fi
            if grep -q "# BEGIN otel-claude-hook-env" "$rc" 2>/dev/null; then
                sed -i.bak '/# BEGIN otel-claude-hook-env/,/# END otel-claude-hook-env/d' "$rc"
                rm -f "${rc}.bak"
            fi
        done
        msg "    ✅ claude alias 已清理" "    ✅ claude alias cleaned"
    fi

    local otel_config="$HOME/.claude/otel-config.json"
    if [ -f "$otel_config" ] && command -v node &>/dev/null; then
        node -e "
const fs = require('fs');
try {
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
  delete cfg.log_enabled;
  delete cfg.log_dir;
  delete cfg.log_filename_format;
  fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + '\n');
} catch {}
" "$otel_config" 2>/dev/null || true
    fi

    if [ -d "$OTEL_CLAUDE_DIR" ]; then
        find "$OTEL_CLAUDE_DIR" -maxdepth 1 \
          ! -name sessions \
          ! -name "$(basename "$OTEL_CLAUDE_DIR")" \
          -exec rm -rf {} + 2>/dev/null || true
        msg "    ✅ 插件文件已删除（sessions/ 已保留）" \
            "    ✅ Plugin files removed (sessions/ preserved)"
    fi

    # --- Codex OTel plugin cleanup ---
    if [ -f "$OTEL_CODEX_DIR/package/scripts/uninstall.sh" ]; then
        bash "$OTEL_CODEX_DIR/package/scripts/uninstall.sh" 2>/dev/null || true
        msg "    ✅ Codex OTel 插件 hooks 已清理" \
            "    ✅ Codex OTel plugin hooks cleaned"
    fi

    local codex_otel_config="$HOME/.codex/otel-config.json"
    if [ -f "$codex_otel_config" ] && command -v node &>/dev/null; then
        node -e "
const fs = require('fs');
try {
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
  delete cfg.log_enabled;
  delete cfg.log_dir;
  delete cfg.log_filename_format;
  fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + '\n');
} catch {}
" "$codex_otel_config" 2>/dev/null || true
    fi

    if [ -d "$OTEL_CODEX_DIR" ]; then
        find "$OTEL_CODEX_DIR" -maxdepth 1 \
          ! -name sessions \
          ! -name "$(basename "$OTEL_CODEX_DIR")" \
          -exec rm -rf {} + 2>/dev/null || true
        msg "    ✅ Codex 插件文件已删除（sessions/ 已保留）" \
            "    ✅ Codex plugin files removed (sessions/ preserved)"
    fi
}

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

    if [ -f "$OTEL_CLAUDE_DIR/package/src/cli.js" ]; then
        echo ""
        msg "💡 Claude Code OTel 插件已安装，请执行以下命令使 alias 生效：" \
            "💡 Claude Code OTel plugin installed. Reload your shell for the alias:"
        echo "   source ~/.bashrc   # or source ~/.zshrc"
    fi

    if [ -f "$OTEL_CODEX_DIR/package/dist/index.js" ]; then
        msg "💡 Codex OTel 插件已安装" \
            "💡 Codex OTel plugin installed"
    fi
    msg "命令:" "Commands:"
    echo "   loongpilot          # 查看状态 / Status"
    echo "   loongpilot info     # 版本与配置 / Version & config"
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

    # Migrate legacy layout if needed
    migrate_legacy_layout

    # Check if already installed
    local cur_ver; cur_ver=$(get_installed_version)
    if [ -n "$cur_ver" ]; then
        msg "⚠️  检测到已安装版本 v${cur_ver}，将执行重新安装" \
            "⚠️  Existing installation v${cur_ver} detected, re-installing"
        echo ""
    fi

    # Stop running service before re-install
    local pid_file="$DATA_DIR/loongpilot.pid"
    if [ -f "$pid_file" ]; then
        local old_pid
        old_pid=$(cat "$pid_file")
        if kill -0 "$old_pid" 2>/dev/null; then
            msg "==> 停止运行中的服务 (PID $old_pid)..." \
                "==> Stopping running service (PID $old_pid)..."
            kill "$old_pid" 2>/dev/null || true
            local count=0
            while kill -0 "$old_pid" 2>/dev/null && [ $count -lt 10 ]; do
                sleep 1
                count=$((count + 1))
            done
            if kill -0 "$old_pid" 2>/dev/null; then
                kill -9 "$old_pid" 2>/dev/null || true
            fi
            rm -f "$pid_file"
            msg "    ✅ 已停止" "    ✅ Stopped"
            echo ""
        else
            rm -f "$pid_file"
        fi
    fi

    trap 'rm -rf "${TMP_DIR:-}"' EXIT
    download_and_extract
    deploy_package "$INSTALL_SRC"
    write_config
    install_loongpilot_command
    install_otel_plugin

    msg "==> 启动服务..." "==> Starting service..."
    if loongpilot start; then
        sleep 2
        if loongpilot status 2>/dev/null | grep -q "is running"; then
            msg "    ✅ 服务已启动" "    ✅ Service started"
        else
            msg "    ⚠️  服务可能尚未就绪，请检查: loongpilot status" \
                "    ⚠️  Service may not be ready. Check: loongpilot status"
        fi
    else
        msg "    ⚠️  服务启动失败，请手动运行: loongpilot start" \
            "    ⚠️  Service failed to start, run manually: loongpilot start"
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

    # Migrate legacy layout if needed
    migrate_legacy_layout

    # Must have an existing installation
    local old_ver; old_ver=$(get_installed_version)
    if [ -z "$old_ver" ]; then
        msg "❌ 未检测到已安装的 loongsuite-pilot，请先执行 install" \
            "❌ No existing installation found. Please run install first."
        exit 1
    fi

    msg "   当前版本: ${old_ver:-unknown}" "   Current version: ${old_ver:-unknown}"
    echo ""

    check_deps

    trap 'rm -rf "${TMP_DIR:-}"' EXIT
    download_and_extract

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
    if command -v loongpilot &>/dev/null; then
        loongpilot stop 2>/dev/null || true
    elif [ -f "$HOME/.local/bin/loongpilot" ]; then
        "$HOME/.local/bin/loongpilot" stop 2>/dev/null || true
    fi
    echo ""

    # Deploy new version to versions/<ver>_<commit>/
    # Old version stays untouched; deploy_package writes current/previous pointers
    deploy_package "$INSTALL_SRC"
    install_loongpilot_command

    # Start the new version
    msg "==> 启动新版本..." "==> Starting new version..."
    if loongpilot start; then
        sleep 2
        if loongpilot status 2>/dev/null | grep -q "is running"; then
            msg "    ✅ 新版本启动成功" "    ✅ New version started successfully"
            echo ""

            # GC: remove old versions beyond current + previous
            gc_old_versions

            print_summary "upgrade"
            return 0
        fi
    fi

    # --- Rollback via version pointer ---
    echo ""
    msg "⚠️  新版本启动失败，正在回滚..." \
        "⚠️  New version failed to start, rolling back..."

    loongpilot stop 2>/dev/null || true

    if command -v loongpilot &>/dev/null; then
        loongpilot rollback 2>/dev/null || true
    else
        "$HOME/.local/bin/loongpilot" rollback 2>/dev/null || true
    fi

    msg "❌ 升级失败，已回滚到 v${old_ver:-unknown}" \
        "❌ Upgrade failed, rolled back to v${old_ver:-unknown}"
    msg "   请检查日志: loongpilot log" "   Check logs: loongpilot log"
    exit 1
}

# ============================================================
# GC: remove old version directories beyond current + previous
# ============================================================
gc_old_versions() {
    local cache_dir="$HOME/.loongsuite-pilot"
    local versions_dir="$cache_dir/versions"
    local current_file="$cache_dir/current"
    local previous_file="$cache_dir/previous"

    [ -d "$versions_dir" ] || return 0

    local keep_current="" keep_previous=""
    if [ -f "$current_file" ]; then
        keep_current=$(cat "$current_file" 2>/dev/null | tr -d '[:space:]')
    fi
    if [ -f "$previous_file" ]; then
        keep_previous=$(cat "$previous_file" 2>/dev/null | tr -d '[:space:]')
    fi

    for d in "$versions_dir"/*/; do
        [ -d "$d" ] || continue
        local name
        name=$(basename "$d")
        if [ "$name" = "$keep_current" ] || [ "$name" = "$keep_previous" ]; then
            continue
        fi
        rm -rf "$d"
    done
}

# ============================================================
# Remove hook entries injected into tool config files
# ============================================================
remove_hook_configs() {
    local HOOK_MARKER=".loongsuite-pilot"
    local configs=(
        "$HOME/.cursor/hooks.json"
        "$HOME/.qoder/settings.json"
        "$HOME/.qoderwork/settings.json"
    )

    for cfg in "${configs[@]}"; do
        [ -f "$cfg" ] || continue
        local short="${cfg/#$HOME/\~}"

        local ok=0
        if command -v node &>/dev/null; then
            node -e "
const fs = require('fs');
const cfg = process.argv[1];
const marker = process.argv[2];
try {
  const data = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== 'object') process.exit(0);
  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter(e => {
      const cmd = e.command || '';
      const nested = Array.isArray(e.hooks) ? e.hooks : [];
      const hasMarker = cmd.includes(marker) || nested.some(h => (h.command || '').includes(marker));
      if (hasMarker) changed = true;
      return !hasMarker;
    });
    if (filtered.length === 0) { delete hooks[event]; changed = true; }
    else hooks[event] = filtered;
  }
  if (changed) {
    fs.writeFileSync(cfg, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    process.stdout.write('cleaned');
  } else {
    process.stdout.write('skip');
  }
} catch(e) { process.stderr.write(e.message); process.exit(1); }
" "$cfg" "$HOOK_MARKER" && ok=1
        fi

        if [ "$ok" -eq 1 ]; then
            msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short"
        else
            msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)"
        fi
    done
}

# ============================================================
# CMD: uninstall
# ============================================================
cmd_uninstall() {
    msg "🗑️  开始卸载 $PACKAGE_NAME ..." \
        "🗑️  Uninstalling $PACKAGE_NAME ..."
    echo ""

    # Stop service (also removes autostart)
    msg "==> 停止服务..." "==> Stopping service..."
    if command -v loongpilot &>/dev/null; then
        loongpilot stop 2>/dev/null || true
    elif [ -f "$HOME/.local/bin/loongpilot" ]; then
        "$HOME/.local/bin/loongpilot" stop 2>/dev/null || true
    else
        local pid_file="$DATA_DIR/loongpilot.pid"
        if [ -f "$pid_file" ]; then
            local pid; pid=$(cat "$pid_file")
            kill "$pid" 2>/dev/null || true
            sleep 2
            kill -9 "$pid" 2>/dev/null || true
            rm -f "$pid_file"
        fi
        # Manual autostart cleanup when loongpilot is unavailable
        local _plist="$HOME/Library/LaunchAgents/com.loongsuite-pilot.plist"
        local _uplist="$HOME/Library/LaunchAgents/com.loongsuite-pilot.updater.plist"
        local _unit="$HOME/.config/systemd/user/loongsuite-pilot.service"
        local _uunit="$HOME/.config/systemd/user/loongsuite-pilot-updater.service"
        for f in "$_uplist" "$_plist"; do
            if [ -f "$f" ]; then
                launchctl unload -w "$f" 2>/dev/null || true
                rm -f "$f"
            fi
        done
        for f in "$_uunit" "$_unit"; do
            if [ -f "$f" ]; then
                systemctl --user disable --now "$(basename "$f")" 2>/dev/null || true
                rm -f "$f"
            fi
        done
        systemctl --user daemon-reload 2>/dev/null || true
    fi
    msg "    ✅ 服务已停止" "    ✅ Service stopped"
    echo ""

    # Remove package directory
    msg "==> 删除安装目录..." "==> Removing installation..."
    rm -rf "$HOME/.loongsuite-pilot"
    msg "    ✅ 已删除 $HOME/.loongsuite-pilot" \
        "    ✅ Removed $HOME/.loongsuite-pilot"

    # Remove loongpilot command
    msg "==> 删除 loongpilot 命令..." "==> Removing loongpilot command..."
    rm -f "$HOME/.local/bin/loongpilot"
    rm -f /usr/local/bin/loongpilot 2>/dev/null || true
    msg "    ✅ loongpilot 命令已删除" "    ✅ loongpilot command removed"
    echo ""

    # Remove hook entries from tool configs
    msg "==> 清理 hook 配置..." "==> Cleaning up hook configs..."
    remove_hook_configs
    echo ""

    # Remove OTel Claude plugin
    msg "==> 清理 OTel Claude 插件..." "==> Cleaning up OTel Claude plugin..."
    remove_otel_plugin
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
