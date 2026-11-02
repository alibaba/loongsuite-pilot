#!/usr/bin/env bash
# installer-opensource.sh — Open-source installer for loongsuite-pilot
#
# Install (first time):
#   curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh | bash
#   curl -fsSL <URL>/installer.sh | bash -s -- install \
#     --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
#     --sls-project "my-project" \
#     --sls-logstore "my-logstore" \
#     --sls-ak-id "your-ak-id" \
#     --sls-ak-secret "your-ak-secret"
#   curl -fsSL <URL>/installer.sh | bash -s -- install \
#     --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
#     --sls-project "my-project" \
#     --sls-logstore "my-logstore" \
#     --sls-api-key "your-api-key" \
#     --multimodal-mode all
#
# Install a specific version:
#   curl -fsSL <URL>/installer.sh | bash -s -- install --version 1.2.0
#
# Optional Dashboard port (default: 8765; preserve existing port on reinstall):
#   curl -fsSL <URL>/installer.sh | bash -s -- install --dashboard-port 9000
#
# Upgrade (preserve config, auto-rollback on failure):
#   curl -fsSL <URL>/installer.sh | bash -s -- upgrade
#
# Uninstall:
#   curl -fsSL <URL>/installer.sh | bash -s -- uninstall
#   curl -fsSL <URL>/installer.sh | bash -s -- uninstall --purge

set -euo pipefail

# ============================================================
# Constants
# ============================================================
PACKAGE_NAME="loongsuite-pilot"
PERMANENT_DIR="$HOME/.loongsuite-pilot/package"
DEFAULT_DATA_DIR="$HOME/.loongsuite-pilot"

# OSS download base URL
_OSS_BASE_URL="https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot"
# Managed Node.js runtime + prebuilt node_modules (downloaded from OSS at install time)
NODE_VERSION="${LOONGSUITE_PILOT_NODE_VERSION:-22.22.2}"
NODE_DEPS_BASE="${LOONGSUITE_PILOT_NODE_DEPS_URL:-https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node}"
NODE_MODULES_BASE="${LOONGSUITE_PILOT_NODE_MODULES_URL:-https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node-modules}"


# ============================================================
# Parse sub-command
# ============================================================
COMMAND=""
PACKAGE_URL="${LOONGSUITE_PILOT_PACKAGE_URL:-}"
INSTALL_VERSION=""
SLS_ENDPOINT=""
SLS_PROJECT=""
SLS_LOGSTORE=""
SLS_AK_ID=""
SLS_AK_SECRET=""
SLS_API_KEY=""
DATA_DIR="$DEFAULT_DATA_DIR"
DASHBOARD_PORT=""
DASHBOARD_PORT_SET=0
LOG_LEVEL=""
USER_ID=""
COLLECT_LOG=""
COLLECT_TRACE=""
ENABLE_STATUS_BAR_APP=""
CMS_LICENSE_KEY=""
CMS_ENDPOINT=""
CMS_WORKSPACE=""
SERVICE_NAME_PREFIX=""
SELECTED_AGENTS=""
AGENT_SELECTION_EXPLICIT=0
ALL_AGENTS=0
MULTIMODAL_MODE=""
MULTIMODAL_MODE_SET=0
# Keep in sync with MULTIMODAL_SUPPORTED_AGENT_IDS.
MULTIMODAL_SUPPORTED_AGENTS="codex,qoder"
EXCLUDE_WORKSPACES=()
MASK_MODE=""
MASK_TYPES=""
MASK_REPLACEMENT_MODE=""
INTERCEPTOR_MODE=""
INTERCEPTOR_TYPES=""
HAS_SUDO=0
PURGE=0
PREFER_SYSTEM_NODE=0

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
        --sls-api-key)        SLS_API_KEY="$2"; shift 2 ;;
        --sls-api-key=*)      SLS_API_KEY="${1#*=}"; shift ;;
        --package-url)        PACKAGE_URL="$2"; shift 2 ;;
        --package-url=*)      PACKAGE_URL="${1#--package-url=}"; shift ;;
        --data-dir)           DATA_DIR="$2"; shift 2 ;;
        --data-dir=*)         DATA_DIR="${1#*=}"; shift ;;
        --dashboard-port)
            if [ "$#" -lt 2 ] || [[ "$2" == --* ]]; then
                echo "--dashboard-port requires an integer between 1 and 65535" >&2
                exit 1
            fi
            DASHBOARD_PORT="$2"; DASHBOARD_PORT_SET=1; shift 2 ;;
        --dashboard-port=*)   DASHBOARD_PORT="${1#*=}"; DASHBOARD_PORT_SET=1; shift ;;
        --log-level)          LOG_LEVEL="$2"; shift 2 ;;
        --log-level=*)        LOG_LEVEL="${1#*=}"; shift ;;
        --userId|--user.id)   USER_ID="$2"; shift 2 ;;
        --userId=*|--user.id=*) USER_ID="${1#*=}"; shift ;;
        --lang)               export LOONGSUITE_PILOT_LANG="$2"; shift 2 ;;
        --lang=*)             export LOONGSUITE_PILOT_LANG="${1#--lang=}"; shift ;;
        --version)            INSTALL_VERSION="$2"; shift 2 ;;
        --version=*)          INSTALL_VERSION="${1#*=}"; shift ;;
        --exclude-workspace)
            if [ "$#" -lt 2 ] || [[ "$2" != /* ]]; then
                echo "--exclude-workspace requires an absolute local directory" >&2
                exit 1
            fi
            EXCLUDE_WORKSPACES+=("$2"); shift 2 ;;
        --exclude-workspace=*)
            excluded_workspace="${1#*=}"
            if [[ "$excluded_workspace" != /* ]]; then
                echo "--exclude-workspace requires an absolute local directory" >&2
                exit 1
            fi
            EXCLUDE_WORKSPACES+=("$excluded_workspace"); shift ;;
        --collect-log)        COLLECT_LOG="$2"; shift 2 ;;
        --collect-log=*)      COLLECT_LOG="${1#*=}"; shift ;;
        --collect-trace)      COLLECT_TRACE="$2"; shift 2 ;;
        --collect-trace=*)    COLLECT_TRACE="${1#*=}"; shift ;;
        --enable-status-bar-app|--enable-status-bar-app=*)
            if [[ "$1" == *=* ]]; then
                ENABLE_STATUS_BAR_APP="${1#*=}"; shift
            else
                if [ "$#" -lt 2 ]; then
                    echo "--enable-status-bar-app requires true or false" >&2
                    exit 1
                fi
                ENABLE_STATUS_BAR_APP="$2"; shift 2
            fi
            case "$ENABLE_STATUS_BAR_APP" in
                true|false) ;;
                *) echo "--enable-status-bar-app requires true or false" >&2; exit 1 ;;
            esac ;;
        --cms-license-key)    CMS_LICENSE_KEY="$2"; shift 2 ;;
        --cms-license-key=*)  CMS_LICENSE_KEY="${1#*=}"; shift ;;
        --cms-endpoint)       CMS_ENDPOINT="$2"; shift 2 ;;
        --cms-endpoint=*)     CMS_ENDPOINT="${1#*=}"; shift ;;
        --cms-workspace)      CMS_WORKSPACE="$2"; shift 2 ;;
        --cms-workspace=*)    CMS_WORKSPACE="${1#*=}"; shift ;;
        --service-name-prefix) SERVICE_NAME_PREFIX="$2"; shift 2 ;;
        --service-name-prefix=*) SERVICE_NAME_PREFIX="${1#*=}"; shift ;;
        --agents)             SELECTED_AGENTS="$2"; AGENT_SELECTION_EXPLICIT=1; shift 2 ;;
        --agents=*)           SELECTED_AGENTS="${1#*=}"; AGENT_SELECTION_EXPLICIT=1; shift ;;
        --all-agents)         ALL_AGENTS=1; shift ;;
        --multimodal-mode)    MULTIMODAL_MODE="${2-}"; MULTIMODAL_MODE_SET=1; shift 2 || shift ;;
        --multimodal-mode=*)  MULTIMODAL_MODE="${1#*=}"; MULTIMODAL_MODE_SET=1; shift ;;
        --mask-mode)          MASK_MODE="$2"; shift 2 ;;
        --mask-mode=*)        MASK_MODE="${1#*=}"; shift ;;
        --mask-types)         MASK_TYPES="$2"; shift 2 ;;
        --mask-types=*)       MASK_TYPES="${1#*=}"; shift ;;
        --mask-replacement-mode) MASK_REPLACEMENT_MODE="$2"; shift 2 ;;
        --mask-replacement-mode=*) MASK_REPLACEMENT_MODE="${1#*=}"; shift ;;
        --interceptor-mode)   INTERCEPTOR_MODE="$2"; shift 2 ;;
        --interceptor-mode=*) INTERCEPTOR_MODE="${1#*=}"; shift ;;
        --interceptor-types)  INTERCEPTOR_TYPES="$2"; shift 2 ;;
        --interceptor-types=*) INTERCEPTOR_TYPES="${1#*=}"; shift ;;
        --purge)              PURGE=1; shift ;;
        --prefer-system-node) PREFER_SYSTEM_NODE=1; shift ;;
        --prefer-system-node=*) PREFER_SYSTEM_NODE=1; shift ;;
        --system-service)
            echo "⚠️  --system-service is deprecated and ignored. Auto-detection is now the default." >&2
            shift ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1 ;;
    esac
done

if [ -n "$ENABLE_STATUS_BAR_APP" ] && [ "$COMMAND" != "install" ]; then
    echo "--enable-status-bar-app is only supported with install" >&2
    exit 1
fi

if [ "$DASHBOARD_PORT_SET" -eq 1 ]; then
    if ! [[ "$DASHBOARD_PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$DASHBOARD_PORT < 1 || 10#$DASHBOARD_PORT > 65535 )); then
        echo "--dashboard-port must be an integer between 1 and 65535" >&2
        exit 1
    fi
fi

if [ -n "$MASK_MODE" ]; then
    case "$MASK_MODE" in
        all|none|custom) ;;
        *)
            echo "❌ Unknown mask mode: $MASK_MODE (use 'all', 'custom', or 'none')" >&2
            exit 1 ;;
    esac
fi
if [ "$MASK_MODE" = "custom" ] && [ -z "$MASK_TYPES" ]; then
    echo "❌ --mask-types is required when --mask-mode custom" >&2
    exit 1
fi
if [ -n "$MASK_TYPES" ] && [ "$MASK_MODE" != "custom" ]; then
    echo "❌ --mask-types can only be used with --mask-mode custom" >&2
    exit 1
fi
if [ -n "$MASK_REPLACEMENT_MODE" ] && [ "$MASK_REPLACEMENT_MODE" != "placeholder" ] && [ "$MASK_REPLACEMENT_MODE" != "preview" ]; then
    echo "❌ Unknown mask replacement mode: $MASK_REPLACEMENT_MODE (use 'placeholder' or 'preview')" >&2
    exit 1
fi
if [ -n "$INTERCEPTOR_MODE" ]; then
    case "$INTERCEPTOR_MODE" in
        all|none|custom) ;;
        *)
            echo "❌ Unknown interceptor mode: $INTERCEPTOR_MODE (use 'all', 'custom', or 'none')" >&2
            exit 1 ;;
    esac
fi
if [ "$INTERCEPTOR_MODE" = "custom" ] && [ -z "$INTERCEPTOR_TYPES" ]; then
    echo "❌ --interceptor-types is required when --interceptor-mode custom" >&2
    exit 1
fi
if [ -n "$INTERCEPTOR_TYPES" ] && [ "$INTERCEPTOR_MODE" != "custom" ]; then
    echo "❌ --interceptor-types can only be used with --interceptor-mode custom" >&2
    exit 1
fi
if [ -n "$SLS_API_KEY" ] && { [ -n "$SLS_AK_ID" ] || [ -n "$SLS_AK_SECRET" ]; }; then
    echo "❌ --sls-api-key cannot be used with --sls-ak-id or --sls-ak-secret" >&2
    exit 1
fi
if [ "$MULTIMODAL_MODE_SET" -eq 1 ]; then
    if [ -z "$MULTIMODAL_MODE" ]; then
        echo "❌ --multimodal-mode requires 'none', 'input', 'output', or 'all'" >&2
        exit 1
    fi
    case "$MULTIMODAL_MODE" in
        none|input|output|all) ;;
            *)
            echo "❌ Unknown multimodal mode: $MULTIMODAL_MODE (use 'none', 'input', 'output', or 'all')" >&2
            exit 1 ;;
    esac
    if [ "$COMMAND" != "install" ]; then
        echo "❌ --multimodal-mode is only supported with install (got $COMMAND)" >&2
        exit 1
    fi
    if [ "$MULTIMODAL_MODE" != "none" ]; then
        if [[ "$SLS_ENDPOINT" != *[![:space:]]* ]] || [[ "$SLS_PROJECT" != *[![:space:]]* ]] \
            || [[ "$SLS_LOGSTORE" != *[![:space:]]* ]] || [[ "$SLS_API_KEY" != *[![:space:]]* ]]; then
            echo "❌ --multimodal-mode $MULTIMODAL_MODE requires --sls-endpoint, --sls-project, --sls-logstore, and --sls-api-key" >&2
            exit 1
        fi
    fi
fi

# Validate current user and sudo access on Linux
validate_install_user() {
    case "$(uname -s)" in
        Linux)
            local current_user
            current_user=$(whoami)
            if [ "$(id -u)" -eq 0 ]; then
                HAS_SUDO=1
                msg "   ✅ 以 root 身份安装（自动使用系统级服务）" \
                    "   ✅ Installing as root (auto system-level service)"
            else
                msg "   Install user: $current_user（服务类型将在启动时自动检测）" \
                    "   Install user: $current_user (service type auto-detected at start)"
            fi
            ;;
    esac
}

# Resolve PACKAGE_URL from OSS if not explicitly set
if [ -z "$PACKAGE_URL" ]; then
    if [ -n "$INSTALL_VERSION" ]; then
        PACKAGE_URL="${_OSS_BASE_URL}/${INSTALL_VERSION}/${PACKAGE_NAME}.tar.gz"
    else
        PACKAGE_URL="${_OSS_BASE_URL}/latest/${PACKAGE_NAME}.tar.gz"
    fi
fi

# ============================================================
# Language detection
# ============================================================
detect_lang() {
    if [ -n "${LOONGSUITE_PILOT_LANG:-}" ]; then echo "$LOONGSUITE_PILOT_LANG"; return; fi
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
_resolve_realpath() {
    realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || echo "$1"
}

_node_is_app_bundle() {
    local resolved
    resolved=$(_resolve_realpath "$1")
    case "$resolved" in
        /Applications/*.app/Contents/*|/System/Applications/*.app/Contents/*|"$HOME"/Applications/*.app/Contents/*)
            return 0
            ;;
    esac
    return 1
}

# node:sqlite is unflagged from 22.13 and 23.4. A major-version check accepts
# Node 20 and 22.12, whose require('node:sqlite') throws, so install would
# succeed and SQLite collection would not. The require is the check.
_node_supports_sqlite() {
    "$1" -e "require('node:sqlite')" >/dev/null 2>&1
}

_node_is_suitable() {
    local bin="$1"
    [ -x "$bin" ] || return 1
    _node_is_app_bundle "$bin" && return 1
    _node_supports_sqlite "$bin" || return 1
    return 0
}

resolve_node() {
    local _candidates=()

    local _nvm_candidates=("$HOME/.nvm/versions/node"/*/bin/node)
    local i
    for (( i=${#_nvm_candidates[@]}-1; i>=0; i-- )); do
        _candidates+=("${_nvm_candidates[i]}")
    done

    _candidates+=(
        "$HOME/.volta/bin/node"
        "$HOME/.fnm/aliases/default/bin/node"
        /opt/homebrew/bin/node
        /usr/local/bin/node
        "$HOME/.local/bin/node"
    )

    if command -v node >/dev/null 2>&1; then
        _candidates+=("$(command -v node)")
    fi

    for candidate in "${_candidates[@]}"; do
        if _node_is_suitable "$candidate"; then
            _resolve_realpath "$candidate"
            return 0
        fi
    done
    return 1
}

# >>> managed-node-runtime >>>
# Managed Node.js runtime + prebuilt node_modules, downloaded from OSS.
# Everything here logs to stderr only: ensure_managed_node is captured via
# $(...) and must print the node path — and nothing else — on stdout.
_mn_msg() {
    if [ "${LANG_MODE:-en}" = "zh" ]; then echo "$1" >&2; else echo "$2" >&2; fi
}

managed_node_platform() {
    local os arch
    case "$(uname -s)" in
        Darwin) os="darwin" ;;
        Linux) os="linux" ;;
        MINGW*|MSYS*|CYGWIN*) os="win" ;;
        *)
            echo "managed node: unsupported platform $(uname -s)" >&2
            return 1 ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) arch="arm64" ;;
        x86_64|amd64) arch="x64" ;;
        *)
            echo "managed node: unsupported architecture $(uname -m)" >&2
            return 1 ;;
    esac
    if [ "$os" = "win" ] && [ "$arch" = "arm64" ]; then
        _mn_msg "managed node: win-arm64 无托管产物，回退系统 node + npm install" \
                "managed node: no win-arm64 artifact, falling back to system node + npm install"
        return 1
    fi
    if [ "$os" = "linux" ] && managed_node_is_musl; then
        _mn_msg "managed node: linux musl (Alpine) 无托管产物，回退系统 node + npm install" \
                "managed node: no linux-musl artifact, falling back to system node + npm install"
        return 1
    fi
    echo "$os $arch"
}

managed_node_is_musl() {
    ls /lib/ld-musl-* >/dev/null 2>&1 && return 0
    ldd --version 2>&1 | grep -qi musl && return 0
    return 1
}

managed_node_download() {
    # managed_node_download <url> <dest>
    # Bounded timeouts mirror the .ps1 installer (-TimeoutSec 600); without
    # them a stalled TCP connection hangs the installer indefinitely.
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 2 --connect-timeout 20 --max-time 600 "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -q --tries=2 --timeout=20 "$1" -O "$2"
    else
        return 1
    fi
}

managed_node_sha256() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        echo "managed node: neither shasum nor sha256sum available" >&2
        return 1
    fi
}

managed_node_verify() {
    # managed_node_verify <archive> <shasums-file> <archive-basename>
    local expected actual
    # [*]? accepts sha256sum binary-mode lines ("<hash> *<name>"), matching
    # the .ps1 installer's Test-ManagedNodeChecksum.
    expected=$(grep -E "[[:space:]][*]?${3}\$" "$2" 2>/dev/null | awk '{print $1}' | head -1)
    if [ -z "$expected" ]; then
        echo "managed node: SHASUMS256.txt has no entry for $3" >&2
        return 1
    fi
    actual=$(managed_node_sha256 "$1") || return 1
    if [ "$expected" != "$actual" ]; then
        echo "managed node: sha256 mismatch for $3 (expected $expected, got $actual)" >&2
        return 1
    fi
    return 0
}

managed_node_bin() {
    # managed_node_bin <node-dir> <os>
    # Prefer the bin/ layout; official Node.js win zips put node.exe at the root.
    local bin="$1/bin/node"
    [ "$2" = "win" ] && bin="$1/bin/node.exe"
    if [ -x "$bin" ]; then
        echo "$bin"
        return 0
    fi
    if [ "$2" = "win" ] && [ -x "$1/node.exe" ]; then
        echo "$1/node.exe"
        return 0
    fi
    return 1
}

ensure_managed_node() {
    local runtime_dir="$DATA_DIR/runtime"
    local tuple os arch
    tuple=$(managed_node_platform) || return 1
    os="${tuple% *}"; arch="${tuple#* }"

    local ext="tar.gz"
    [ "$os" = "win" ] && ext="zip"
    local archive="node-v${NODE_VERSION}-${os}-${arch}.${ext}"
    local node_dir="$runtime_dir/node-v${NODE_VERSION}-${os}-${arch}"
    local node_bin=""
    node_bin=$(managed_node_bin "$node_dir" "$os") || node_bin=""

    if [ -n "$node_bin" ] && [ "$("$node_bin" --version 2>/dev/null)" = "v${NODE_VERSION}" ]; then
        echo "$node_bin"
        return 0
    fi

    local base="${NODE_DEPS_BASE%/}/${NODE_VERSION}"
    local tmp
    tmp=$(mktemp -d) || return 1

    _mn_msg "==> 下载托管 Node.js v${NODE_VERSION} (${os}-${arch})..." \
            "==> Downloading managed Node.js v${NODE_VERSION} (${os}-${arch})..."
    if ! managed_node_download "$base/$archive" "$tmp/$archive" \
        || ! managed_node_download "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" \
        || ! managed_node_verify "$tmp/$archive" "$tmp/SHASUMS256.txt" "$archive"; then
        rm -rf "$tmp"
        return 1
    fi

    mkdir -p "$runtime_dir"
    rm -rf "$node_dir"
    if [ "$ext" = "zip" ]; then
        if ! command -v unzip >/dev/null 2>&1 || ! unzip -q "$tmp/$archive" -d "$runtime_dir"; then
            rm -rf "$tmp" "$node_dir"
            return 1
        fi
    else
        if ! { tar --warning=no-unknown-keyword -xzf "$tmp/$archive" -C "$runtime_dir" 2>/dev/null \
                || tar -xzf "$tmp/$archive" -C "$runtime_dir"; }; then
            rm -rf "$tmp" "$node_dir"
            return 1
        fi
    fi
    rm -rf "$tmp"

    node_bin=$(managed_node_bin "$node_dir" "$os") || node_bin=""
    if [ -z "$node_bin" ]; then
        echo "managed node: extracted archive has no usable node binary under $node_dir (bin/node or node.exe)" >&2
        rm -rf "$node_dir"
        return 1
    fi
    if [ "$os" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
        xattr -dr com.apple.quarantine "$node_dir" 2>/dev/null || true
    fi
    echo "$node_bin"
}

ensure_node_modules() {
    # ensure_node_modules <app-version>  (expects PERMANENT_DIR to point at the deployed version dir)
    local app_version="${1:-latest}"
    local tuple os arch
    tuple=$(managed_node_platform) || return 1
    os="${tuple% *}"; arch="${tuple#* }"

    local modules_dir="$PERMANENT_DIR/node_modules"
    local marker="$modules_dir/.pilot-modules-version"
    local stamp="${app_version} ${os} ${arch}"
    if [ -d "$modules_dir" ] && [ "$(cat "$marker" 2>/dev/null)" = "$stamp" ]; then
        return 0
    fi

    local archive="node-modules-${os}-${arch}.tar.gz"
    local base="${NODE_MODULES_BASE%/}/${app_version}"
    local tmp
    tmp=$(mktemp -d) || return 1

    _mn_msg "==> 下载预编译 node_modules (${os}-${arch}, app v${app_version})..." \
            "==> Downloading prebuilt node_modules (${os}-${arch}, app v${app_version})..."
    if ! managed_node_download "$base/$archive" "$tmp/$archive" \
        || ! managed_node_download "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" \
        || ! managed_node_verify "$tmp/$archive" "$tmp/SHASUMS256.txt" "$archive"; then
        rm -rf "$tmp"
        return 1
    fi

    local stage="$tmp/stage"
    mkdir -p "$stage"
    if ! { tar --warning=no-unknown-keyword -xzf "$tmp/$archive" -C "$stage" 2>/dev/null \
            || tar -xzf "$tmp/$archive" -C "$stage"; }; then
        rm -rf "$tmp"
        return 1
    fi
    if [ ! -d "$stage/node_modules" ]; then
        rm -rf "$tmp"
        echo "managed node_modules: archive does not contain node_modules/" >&2
        return 1
    fi
    echo "$stamp" > "$stage/node_modules/.pilot-modules-version"
    rm -rf "$modules_dir"
    if ! mv "$stage/node_modules" "$modules_dir"; then
        rm -rf "$tmp"
        return 1
    fi
    rm -rf "$tmp"
    return 0
}

run_npm() {
    # npm shipped with the managed runtime is a symlink to npm-cli.js, whose
    # `#!/usr/bin/env node` shebang resolves node through PATH. The runtime's bin dir
    # is not on PATH, so calling "$NPM_BIN" directly dies with
    # "env: node: No such file or directory" on hosts without a system node — exactly
    # the hosts the managed runtime exists for. Mirrors the .ps1 npm fallback, which
    # already prepends the node dir.
    PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" "$@"
}
# <<< managed-node-runtime <<<

check_deps() {
    msg "==> 检查下载与解压工具..." "==> Checking download and archive tools..."
    if ! command -v tar >/dev/null 2>&1; then
        printf '%s\n' '缺少 tar，无法解压原生安装包' >&2
        return 1
    fi
    if [ ! -f "$PACKAGE_URL" ] && [[ "$PACKAGE_URL" != file://* ]] \
        && ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        printf '%s\n' '缺少 curl 或 wget，无法下载安装包' >&2
        return 1
    fi
    if [ "${PREFER_SYSTEM_NODE:-0}" -eq 1 ]; then
        printf '%s\n' '--prefer-system-node 已弃用；原生安装不使用 Node.js' >&2
    fi
}

# ============================================================
# Common: download and extract package -> sets INSTALL_SRC
# ============================================================
download_and_extract() {
    TMP_DIR="$(mktemp -d)"
    # TMP_DIR cleanup is handled by the caller's trap

    msg "==> 下载安装包: $PACKAGE_URL" \
        "==> Downloading: $PACKAGE_URL"

    if [ -f "$PACKAGE_URL" ]; then
        cp "$PACKAGE_URL" "$TMP_DIR/package.tar.gz"
    elif [[ "$PACKAGE_URL" == file://* ]]; then
        cp "${PACKAGE_URL#file://}" "$TMP_DIR/package.tar.gz"
    elif command -v curl &>/dev/null; then
        curl -fsSL --retry 2 --connect-timeout 20 --max-time 600 "$PACKAGE_URL" -o "$TMP_DIR/package.tar.gz"
    else
        wget -q --tries=2 --timeout=20 "$PACKAGE_URL" -O "$TMP_DIR/package.tar.gz"
    fi
    msg "    ✅ 下载完成" "    ✅ Downloaded"
    echo ""

    msg "==> 解压安装包..." "==> Extracting..."
    if tar --warning=no-unknown-keyword -xzf "$TMP_DIR/package.tar.gz" -C "$TMP_DIR" 2>/dev/null; then
        :
    else
        tar -xzf "$TMP_DIR/package.tar.gz" -C "$TMP_DIR"
    fi

    select_native_package_root "$TMP_DIR" || return 1
    msg "    ✅ 解压完成" "    ✅ Extracted"
    echo ""
}

select_native_package_root() {
    local directory="$1" candidate
    local roots=()
    for candidate in "$directory" "$directory"/*; do
        [ -d "$candidate" ] || continue
        [ ! -L "$candidate" ] && [ ! -L "$candidate/bin" ] \
            && [ ! -L "$candidate/runtime-manifest.json" ] \
            && [ ! -L "$candidate/bin/loongsuite-pilot" ] || continue
        if [ -f "$candidate/runtime-manifest.json" ] && [ -f "$candidate/bin/loongsuite-pilot" ] \
            && [ -x "$candidate/bin/loongsuite-pilot" ]; then
            roots+=("$candidate")
        fi
    done
    if [ "${#roots[@]}" -ne 1 ]; then
        printf '%s\n' '安装包必须且只能包含一个原生运行清单与二进制根目录' >&2
        return 1
    fi
    INSTALL_SRC="${roots[0]}"
}

# ============================================================
# Agent 探测由候选原生二进制执行。
# ============================================================
PROBE_RESULT="[]"

probe_agents() {
    msg "==> 探测 AI Agent..." "==> Probing AI Agents..."
    local probe_bin="$INSTALL_SRC/bin/loongsuite-pilot"
    if [ ! -x "$probe_bin" ]; then
        printf '%s\n' '候选包缺少原生探测入口' >&2
        return 1
    fi
    PROBE_RESULT=$(AGENT_DATA_COLLECTION_CONFIG="$DATA_DIR/config.json" "$probe_bin" probe --installer) || return 1
    local count
    count=$(printf '%s' "$PROBE_RESULT" | native_installer_helper probe-count) || return 1
    msg "    ✅ 探测到 ${count} 个 Agent 定义" "    ✅ Found ${count} agent definitions"
    echo ""
}

# ============================================================
# Agent selection: interactive menu or --agents flag
# ============================================================
select_agents() {
    # --all-agents: collect every agent. Skip selection entirely and leave no
    # enabled gate in config (other agent settings survive), so pilot auto-detects
    # all agents at runtime — including ones installed after this run.
    if [ "$ALL_AGENTS" = "1" ]; then
        if [ -n "$SELECTED_AGENTS" ]; then
            msg "    ⚠️  --all-agents 已启用，忽略 --agents 指定的列表" \
                "    ⚠️  --all-agents is set; ignoring the --agents list"
            SELECTED_AGENTS=""
        fi
        msg "    采集全部 Agent (不写入选择，由 pilot 运行时自动探测)" \
            "    Collecting all agents (no selection written; pilot auto-detects at runtime)"
        echo ""
        return 0
    fi

    if [ -n "$SELECTED_AGENTS" ]; then
        msg "    使用指定的 Agent: $SELECTED_AGENTS" "    Using specified agents: $SELECTED_AGENTS"
        echo ""
        return 0
    fi

    local agent_count
    agent_count=$(printf '%s' "$PROBE_RESULT" | native_installer_helper probe-count) || return 1
    if [ "$agent_count" = "0" ]; then
        return 0
    fi

    # Non-interactive: auto-select all detected agents
    if [ ! -t 0 ]; then
        SELECTED_AGENTS=$(printf '%s' "$PROBE_RESULT" | native_installer_helper probe-detected) || return 1
        msg "    (非交互模式) 自动选择已检测到的 Agent: $SELECTED_AGENTS" \
            "    (non-interactive) Auto-selected detected agents: $SELECTED_AGENTS"
        echo ""
        return 0
    fi

    printf '%s' "$PROBE_RESULT" | native_installer_helper probe-menu --lang "$LANG_MODE" || return 1
    local select_input
    printf "    > " >&2
    read -r select_input || return 1
    if [ -n "${select_input//[[:space:]]/}" ]; then AGENT_SELECTION_EXPLICIT=1; fi
    SELECTED_AGENTS=$(printf '%s' "$PROBE_RESULT" | native_installer_helper probe-select --selection "$select_input") || return 1

    if [ -n "$SELECTED_AGENTS" ]; then
        msg "    已选择: $SELECTED_AGENTS" "    Selected: $SELECTED_AGENTS"
    else
        msg "    未选择任何 Agent" "    No agents selected"
    fi
    echo ""
}

# ============================================================
# Interactive: prompt for userId (skipped when --userId given or non-interactive)
# ============================================================
prompt_user_id() {
    if [ -n "$USER_ID" ]; then return 0; fi
    if [ ! -t 0 ]; then return 0; fi

    local existing_uid=""
    local config_file="$DATA_DIR/config.json"
    if [ -f "$config_file" ]; then
        existing_uid=$(native_installer_helper read-user-id --config "$config_file") || return 1
    fi

    echo ""
    if [ -n "$existing_uid" ]; then
        msg "    当前 userId: $existing_uid" \
            "    Current userId: $existing_uid"
        msg "    直接回车保留，或输入新值:" \
            "    Press Enter to keep, or type a new value:"
    else
        msg "    请输入你的 userId（用于数据归属，可直接回车跳过）:" \
            "    Enter your userId (for data attribution, press Enter to skip):"
    fi
    printf "    > "
    local input
    read -r input
    input=$(echo "$input" | tr -d '[:space:]')
    if [ -n "$input" ]; then
        USER_ID="$input"
    elif [ -n "$existing_uid" ]; then
        USER_ID="$existing_uid"
    fi
}

# ============================================================
# Interactive: confirm config overwrite when key fields differ
# ============================================================
confirm_config_overwrite() {
    local config_file="$DATA_DIR/config.json"
    if [ ! -f "$config_file" ]; then return 0; fi

    local diffs
    diffs=$(installer_config_operation config-diffs) || return 1

    if [ -z "$diffs" ]; then return 0; fi

    echo ""
    msg "⚠️  以下配置将被覆盖:" "⚠️  The following config will be overwritten:"
    echo "$diffs" | while IFS= read -r line; do
        echo "    $line"
    done

    if [ -t 0 ]; then
        echo ""
        msg "    确认覆盖? (y/N):" "    Confirm overwrite? (y/N):"
        printf "    > "
        local answer
        read -r answer
        case "$answer" in
            y|Y|yes|YES) ;;
            *)
                msg "已取消安装" "Installation cancelled"
                exit 0
                ;;
        esac
    else
        msg "    (非交互模式) 继续覆盖" \
            "    (non-interactive) Proceeding with overwrite"
    fi
}

# ============================================================
# Common: deploy bootstrap scripts from the current version
# ============================================================
installer_runtime_operation() {
    local source="$1" operation="$2"
    local flags=()
    if [ "${3:-}" = "deploy-hooks" ]; then flags+=(--deploy-hooks); fi
    if [ "${INSTALL_CONFIG:-0}" -eq 1 ] && [ "$operation" != "sync-service" ]; then
        LP_SOURCE_DIR="$source" LP_CACHE_DIR="${LOONGSUITE_PILOT_CACHE_DIR:-$HOME/.loongsuite-pilot}" \
            LP_BIN_DIR="$HOME/.local/bin" installer_config_operation "$operation" --with-config ${flags[@]+"${flags[@]}"}
    else
        LP_SOURCE_DIR="$source" LP_CACHE_DIR="${LOONGSUITE_PILOT_CACHE_DIR:-$HOME/.loongsuite-pilot}" \
            LP_DATA_DIR="$DATA_DIR" LP_CONFIG_PATH="$DATA_DIR/config.json" \
            LP_BIN_DIR="$HOME/.local/bin" native_installer_helper "$operation" --from-env ${flags[@]+"${flags[@]}"}
    fi
}

deploy_bootstrap_scripts() {
    installer_runtime_operation "$PERMANENT_DIR" sync-service
}

# ============================================================
# Common: deploy package to versions/ directory
# ============================================================
prepare_package() {
    local candidate_name
    candidate_name=$(installer_runtime_operation "$1" stage-package) || return 1
    STAGED_DIR="${LOONGSUITE_PILOT_CACHE_DIR:-$HOME/.loongsuite-pilot}/versions/$candidate_name"
    msg "    ✅ Rust 候选包及配置已校验: $STAGED_DIR" "    ✅ Rust candidate and config verified: $STAGED_DIR"
}

deploy_package() {
    # 配置合并、Hook 调用与版本入口发布由同一个原生操作串行执行。
    installer_runtime_operation "$1" publish-package deploy-hooks || return 1
    PERMANENT_DIR="$1"
    PILOT_BIN="$PERMANENT_DIR/bin/loongsuite-pilot"
    msg "    ✅ 原生包及 Hook 已部署" "    ✅ Native package and hooks deployed"
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
native_installer_helper() {
    local binary="${INSTALL_SRC:?}/bin/loongsuite-pilot"
    if [ ! -x "$binary" ]; then
        printf '%s\n' '候选包缺少原生安装辅助入口' >&2
        return 1
    fi
    "$binary" installer-helper "$@"
}

installer_config_operation() {
    local operation="$1"
    shift
    local excluded_workspaces_json=""
    if [ "${#EXCLUDE_WORKSPACES[@]}" -gt 0 ]; then
        excluded_workspaces_json=$(native_installer_helper json-argv -- "${EXCLUDE_WORKSPACES[@]}") || return 1
    fi
    # 选项通过子进程环境传递，不插入脚本代码、argv 或诊断。
    printf '%s' "$PROBE_RESULT" | \
        LP_CONFIG_PATH="$DATA_DIR/config.json" LP_DATA_DIR="$DATA_DIR" \
        LP_EXCLUDE_WORKSPACES="$excluded_workspaces_json" \
        LP_SLS_ENDPOINT="$SLS_ENDPOINT" LP_SLS_PROJECT="$SLS_PROJECT" LP_SLS_LOGSTORE="$SLS_LOGSTORE" \
        LP_SLS_AK_ID="$SLS_AK_ID" LP_SLS_AK_SECRET="$SLS_AK_SECRET" LP_SLS_API_KEY="$SLS_API_KEY" \
        LP_LOG_LEVEL="$LOG_LEVEL" LP_USER_ID="$USER_ID" \
        LP_COLLECT_LOG="$COLLECT_LOG" LP_COLLECT_TRACE="$COLLECT_TRACE" \
        LP_CMS_LICENSE_KEY="$CMS_LICENSE_KEY" LP_CMS_ENDPOINT="$CMS_ENDPOINT" LP_CMS_WORKSPACE="$CMS_WORKSPACE" \
        LP_SERVICE_NAME_PREFIX="$SERVICE_NAME_PREFIX" \
        LP_SELECTED_AGENTS="$SELECTED_AGENTS" LP_ALL_AGENTS="$ALL_AGENTS" \
        LP_AGENT_SELECTION_EXPLICIT="$AGENT_SELECTION_EXPLICIT" \
        LP_MULTIMODAL_MODE="$MULTIMODAL_MODE" LP_MULTIMODAL_SUPPORTED_AGENTS="$MULTIMODAL_SUPPORTED_AGENTS" \
        LP_DASHBOARD_PORT="$DASHBOARD_PORT" LP_ENABLE_STATUS_BAR_APP="$ENABLE_STATUS_BAR_APP" \
        LP_MASK_MODE="$MASK_MODE" LP_MASK_TYPES="$MASK_TYPES" LP_MASK_REPLACEMENT_MODE="$MASK_REPLACEMENT_MODE" \
        LP_INTERCEPTOR_MODE="$INTERCEPTOR_MODE" LP_INTERCEPTOR_TYPES="$INTERCEPTOR_TYPES" \
        native_installer_helper "$operation" --from-env "$@"
}

write_config() {
    msg "==> 写入配置文件 $DATA_DIR/config.json ..." "==> Writing config to $DATA_DIR/config.json ..."
    installer_config_operation write-config || return 1
    msg "    ✅ 配置已写入" "    ✅ Config written"
    echo ""
}

# ============================================================
# Common: install/update the loongsuite-pilot service management script
# ============================================================
install_loongsuite_pilot_command() {
    msg "==> 安装服务管理脚本..." "==> Installing service management script..."
    local global_bin_dir="$HOME/.local/bin"
    local loongsuite_pilot_cmd="$global_bin_dir/loongsuite-pilot"
    deploy_bootstrap_scripts || return 1
    msg "    ✅ 已安装: $loongsuite_pilot_cmd" "    ✅ Installed: $loongsuite_pilot_cmd"

    # If /usr/local/bin is writable (root), create a symlink for immediate PATH access
    if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
        ln -sf "$loongsuite_pilot_cmd" /usr/local/bin/loongsuite-pilot
        msg "    ✅ 已链接到 /usr/local/bin/loongsuite-pilot" "    ✅ Linked to /usr/local/bin/loongsuite-pilot"
    else
        ensure_path_block() {
            local file="$1"
            if [ ! -f "$file" ]; then
                touch "$file" 2>/dev/null || return 0
            fi
            if [ ! -w "$file" ]; then
                msg "    ⚠️  $file 不可写，跳过" "    ⚠️  $file is not writable, skipping"
                return 0
            fi
            if grep -q '\.local/bin' "$file" 2>/dev/null; then return 0; fi
            # Ensure file ends with a newline before appending
            [ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ] && echo "" >> "$file"
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
                # Do not create ~/.bash_profile just to add PATH. On Debian/Ubuntu
                # style accounts, its mere presence prevents bash login shells from
                # reading ~/.profile, which often sources ~/.bashrc and user aliases.
                if [ -f "$HOME/.bash_profile" ]; then
                    ensure_path_block "$HOME/.bash_profile" || true
                elif [ -f "$HOME/.bash_login" ]; then
                    ensure_path_block "$HOME/.bash_login" || true
                else
                    ensure_path_block "$HOME/.profile" || true
                fi
                ;;
            *)
                ensure_path_block "$HOME/.bashrc" || true
                ;;
        esac
    fi
    echo ""

    # Ensure loongsuite-pilot is on PATH for the rest of this script
    export PATH="$global_bin_dir:$PATH"
}

# ============================================================
# qodercli token intercept: inject/remove shell function
# ============================================================
_sed_inplace() {
    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# Is `needle` present INSIDE the begin/end marker region of `file`?
# Signature checks must be scoped this way rather than grepping the whole rc
# file: the qodercli and qoderclicn blocks both name the same wrapper script, so
# a file-wide match lets one block vouch for the other and a stale block never
# gets migrated. Mirrors extractMarkerBlock() in src/core/hook-watchdog.ts.
_rc_block_contains() {
    local file="$1" begin="$2" end="$3" needle="$4"
    sed -n "/$begin/,/$end/p" "$file" 2>/dev/null | grep -qF "$needle"
}

inject_qodercli_token_intercept() {
    # Not selected: clean up any stale block from a prior install, then bail.
    if [ "$ALL_AGENTS" != "1" ] && ! echo "$SELECTED_AGENTS" | grep -q 'qoder'; then remove_qodercli_token_intercept; return 0; fi
    if ! command -v qodercli >/dev/null 2>&1; then return 0; fi

    local intercept_script="$DATA_DIR/hooks/qodercli-token-intercept.mjs"
    local runtime_wrapper="$DATA_DIR/hooks/qodercli-runtime-wrapper.sh"
    if [ ! -f "$intercept_script" ] || [ ! -f "$runtime_wrapper" ]; then return 0; fi

    msg "==> 配置 qodercli token 采集..." "==> Configuring qodercli token intercept..."

    _inject_to_rc() {
        local file="$1"
        if [ ! -f "$file" ]; then return 0; fi
        if [ ! -w "$file" ]; then
            msg "    ⚠️  $file 不可写，跳过" "    ⚠️  $file is not writable, skipping"
            return 0
        fi
        # Migrate-or-skip: our block may already be present. If it is the current
        # guard shape (signature line present) we're done; otherwise it is an
        # older released bare-function block sharing the same marker — remove it
        # so the new guarded block below replaces it (the old bare block
        # parse-errors under a user alias, which is exactly what we're fixing).
        if grep -q 'loongsuite-pilot BEGIN qodercli-intercept' "$file" 2>/dev/null; then
            if _rc_block_contains "$file" \
                'loongsuite-pilot BEGIN qodercli-intercept' \
                'loongsuite-pilot END qodercli-intercept' \
                'qodercli-runtime-wrapper.sh'; then return 0; fi
            _sed_inplace '/# loongsuite-pilot BEGIN qodercli-intercept/,/# loongsuite-pilot END qodercli-intercept/d' "$file"
        fi
        [ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ] && echo "" >> "$file"
        # Double-quoted heredoc so $DATA_DIR expands at install time, honoring
        # --data-dir overrides. $@ is escaped to defer expansion to runtime.
        # The `if ! alias ... eval '...'` shape guards against clobbering a
        # user's own qodercli alias/function AND avoids a parse error: a bare
        # qodercli() token would fail to parse under an active alias (interactive
        # shells expand aliases at parse time, before the guard runs), so the
        # definition is deferred behind eval. Keep byte-identical to the
        # watchdog's blockFn (src/core/hook-watchdog.ts).
        cat >> "$file" << INTERCEPTBLOCK

# loongsuite-pilot BEGIN qodercli-intercept
if ! alias qodercli >/dev/null 2>&1 && ! typeset -f qodercli >/dev/null 2>&1; then
  eval 'qodercli() { "$DATA_DIR/hooks/qodercli-runtime-wrapper.sh" "\$@"; }'
fi
# loongsuite-pilot END qodercli-intercept
INTERCEPTBLOCK
        msg "    ✅ 已写入 $file (请执行 source $file 或打开新终端)" \
            "    ✅ Written to $file (run: source $file or open a new terminal)"
    }

    case "${SHELL:-/bin/bash}" in
        */zsh)  _inject_to_rc "$HOME/.zshrc" ;;
        */bash) _inject_to_rc "$HOME/.bashrc" ;;
        *)      _inject_to_rc "$HOME/.bashrc" ;;
    esac

    # If the user already defines their own `qodercli`, our guard skipped the
    # wrapper (to avoid clobbering it), so collection won't run. Tell them how
    # to opt in, since there is otherwise no signal explaining the silence.
    if _rc_user_override_present qodercli \
        'loongsuite-pilot BEGIN qodercli-intercept' \
        'loongsuite-pilot END qodercli-intercept'; then
        msg "    ⚠️  检测到你已自定义 qodercli(alias/function)，为避免覆盖，采集未启用。" \
            "    ⚠️  Detected your own 'qodercli' (alias/function); collection is disabled to avoid clobbering it."
        msg "        如需启用采集，请让你的定义调用： $runtime_wrapper" \
            "        To enable collection, have your definition call: $runtime_wrapper"
    fi
    echo ""
}

remove_qodercli_token_intercept() {
    for file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        if [ -f "$file" ] && grep -q 'loongsuite-pilot BEGIN qodercli-intercept' "$file" 2>/dev/null; then
            _sed_inplace '/# loongsuite-pilot BEGIN qodercli-intercept/,/# loongsuite-pilot END qodercli-intercept/d' "$file"
            msg "    已清理 qodercli token intercept ($file)" \
                "    Cleaned up qodercli token intercept ($file)"
        fi
    done
}

# The CN line gets its own function rather than sharing the one above: that
# block's exact bytes are part of a released idempotency contract (the watchdog
# greps for them), so it is left untouched. Only the marker and the flavor
# variable differ here — the wrapper and preload script are the same assets.
inject_qoderclicn_token_intercept() {
    # Not selected: clean up any stale block from a prior install, then bail.
    if [ "$ALL_AGENTS" != "1" ] && ! echo "$SELECTED_AGENTS" | grep -q 'qoder-cn'; then remove_qoderclicn_token_intercept; return 0; fi
    if ! command -v qoderclicn >/dev/null 2>&1; then return 0; fi

    local intercept_script="$DATA_DIR/hooks/qodercli-token-intercept.mjs"
    local runtime_wrapper="$DATA_DIR/hooks/qodercli-runtime-wrapper.sh"
    if [ ! -f "$intercept_script" ] || [ ! -f "$runtime_wrapper" ]; then return 0; fi

    msg "==> 配置 qoderclicn token 采集..." "==> Configuring qoderclicn token intercept..."

    _inject_cn_to_rc() {
        local file="$1"
        if [ ! -f "$file" ]; then return 0; fi
        if [ ! -w "$file" ]; then
            msg "    ⚠️  $file 不可写，跳过" "    ⚠️  $file is not writable, skipping"
            return 0
        fi
        # Migrate-or-skip, same shape as the qodercli block: the signature is the
        # flavor assignment, since the wrapper name cannot tell the two apart.
        if grep -q 'loongsuite-pilot BEGIN qoderclicn-intercept' "$file" 2>/dev/null; then
            if _rc_block_contains "$file" \
                'loongsuite-pilot BEGIN qoderclicn-intercept' \
                'loongsuite-pilot END qoderclicn-intercept' \
                'LOONGSUITE_QODERCLI_FLAVOR=qoderclicn'; then return 0; fi
            _sed_inplace '/# loongsuite-pilot BEGIN qoderclicn-intercept/,/# loongsuite-pilot END qoderclicn-intercept/d' "$file"
        fi
        [ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ] && echo "" >> "$file"
        # Double-quoted heredoc so $DATA_DIR expands at install time. $@ is
        # escaped to defer expansion to runtime. Keep byte-identical to the
        # watchdog's blockFn (src/core/hook-watchdog.ts, id qoderclicn-rc).
        cat >> "$file" << INTERCEPTBLOCK

# loongsuite-pilot BEGIN qoderclicn-intercept
if ! alias qoderclicn >/dev/null 2>&1 && ! typeset -f qoderclicn >/dev/null 2>&1; then
  eval 'qoderclicn() { LOONGSUITE_QODERCLI_FLAVOR=qoderclicn "$DATA_DIR/hooks/qodercli-runtime-wrapper.sh" "\$@"; }'
fi
# loongsuite-pilot END qoderclicn-intercept
INTERCEPTBLOCK
        msg "    ✅ 已写入 $file (请执行 source $file 或打开新终端)" \
            "    ✅ Written to $file (run: source $file or open a new terminal)"
    }

    case "${SHELL:-/bin/bash}" in
        */zsh)  _inject_cn_to_rc "$HOME/.zshrc" ;;
        */bash) _inject_cn_to_rc "$HOME/.bashrc" ;;
        *)      _inject_cn_to_rc "$HOME/.bashrc" ;;
    esac

    if _rc_user_override_present qoderclicn \
        'loongsuite-pilot BEGIN qoderclicn-intercept' \
        'loongsuite-pilot END qoderclicn-intercept'; then
        msg "    ⚠️  检测到你已自定义 qoderclicn(alias/function)，为避免覆盖，采集未启用。" \
            "    ⚠️  Detected your own 'qoderclicn' (alias/function); collection is disabled to avoid clobbering it."
        msg "        如需启用采集，请让你的定义调用： LOONGSUITE_QODERCLI_FLAVOR=qoderclicn $runtime_wrapper" \
            "        To enable collection, have your definition call: LOONGSUITE_QODERCLI_FLAVOR=qoderclicn $runtime_wrapper"
    fi
    echo ""
}

remove_qoderclicn_token_intercept() {
    for file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        if [ -f "$file" ] && grep -q 'loongsuite-pilot BEGIN qoderclicn-intercept' "$file" 2>/dev/null; then
            _sed_inplace '/# loongsuite-pilot BEGIN qoderclicn-intercept/,/# loongsuite-pilot END qoderclicn-intercept/d' "$file"
            msg "    已清理 qoderclicn token intercept ($file)" \
                "    Cleaned up qoderclicn token intercept ($file)"
        fi
    done
}


# ============================================================
# Claude Code fetch intercept: inject/remove shell function
#
# Why a shell wrapper instead of ~/.claude/settings.json env:
#   Claude Code is a Bun-compiled binary. Bun reads BUN_OPTIONS at runtime
#   startup (before any JS executes), so settings.json env values are too
#   late — they only affect Claude Code's child processes, not the Bun
#   preload of the main process. A shell wrapper that sets BUN_OPTIONS
#   before invoking `claude` is the only reliable injection point.
#
# The wrapper prepends our preload but preserves any existing BUN_OPTIONS
# the user (or qodercli wrapper, or launchd setenv) may have set.
# ============================================================
# Detect a user-defined <cli> alias/function OUTSIDE our managed block.
#   $1=cli name  $2=BEGIN marker substring  $3=END marker substring
# Returns 0 (true) when found. Our injected wrapper's `if ! alias ...` guard
# intentionally skips such users to avoid clobbering their setup — which means
# collection is silently off for them. This lets the installer surface a
# one-time, actionable hint at install time (rc is sourced too often to warn on
# every shell). Heuristic: scans common rc files with our block stripped; misses
# aliases defined in files those rc's source.
_rc_user_override_present() {
    local cli="$1" begin="$2" end="$3" file
    for file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        [ -f "$file" ] || continue
        if sed "/$begin/,/$end/d" "$file" 2>/dev/null \
           | grep -Eq "^[[:space:]]*(alias[[:space:]]+$cli=|(function[[:space:]]+)?$cli[[:space:]]*\(\)|function[[:space:]]+$cli([[:space:]]|\{|\$))"; then
            return 0
        fi
    done
    return 1
}

inject_claude_code_fetch_intercept() {
    # Not selected: clean up any stale block from a prior install, then bail.
    if [ "$ALL_AGENTS" != "1" ] && ! echo "$SELECTED_AGENTS" | grep -q 'claude-code'; then remove_claude_code_fetch_intercept; return 0; fi
    if ! command -v claude >/dev/null 2>&1; then return 0; fi

    local intercept_script="$DATA_DIR/hooks/claude-code-fetch-intercept.mjs"
    if [ ! -f "$intercept_script" ]; then return 0; fi

    msg "==> 配置 claude-code fetch 拦截..." "==> Configuring claude-code fetch intercept..."

    _inject_to_rc() {
        local file="$1"
        if [ ! -f "$file" ]; then return 0; fi
        if [ ! -w "$file" ]; then
            msg "    ⚠️  $file 不可写，跳过" "    ⚠️  $file is not writable, skipping"
            return 0
        fi
        # Migrate-or-skip: our block may already be present. If it is the current
        # guard shape (signature line present) we're done; otherwise it is an
        # older released bare-function block sharing the same marker — remove it
        # so the new guarded block below replaces it (the old bare block
        # parse-errors under a user alias, which is exactly what we're fixing).
        if grep -q 'loongsuite-pilot BEGIN claude-code-intercept' "$file" 2>/dev/null; then
            if grep -qF 'if ! alias claude >/dev/null 2>&1' "$file"; then return 0; fi
            _sed_inplace '/# loongsuite-pilot BEGIN claude-code-intercept/,/# loongsuite-pilot END claude-code-intercept/d' "$file"
        fi
        [ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ] && echo "" >> "$file"
        # Double-quoted heredoc so $DATA_DIR expands at install time, honoring
        # --data-dir overrides. Other refs (${BUN_OPTIONS}, $@) are escaped to
        # defer expansion until the wrapper actually runs in the user's shell.
        # The `if ! alias ... eval '...'` shape guards against clobbering a
        # user's own claude alias/function (e.g. a proxy+flags alias) AND avoids
        # a parse error: a bare claude() token would fail to parse under an
        # active alias (interactive shells expand aliases at parse time, before
        # the guard runs), so the definition is deferred behind eval. Keep
        # byte-identical to the watchdog's blockFn (src/core/hook-watchdog.ts).
        cat >> "$file" << INTERCEPTBLOCK

# loongsuite-pilot BEGIN claude-code-intercept
if ! alias claude >/dev/null 2>&1 && ! typeset -f claude >/dev/null 2>&1; then
  eval 'claude() { BUN_OPTIONS="--preload=$DATA_DIR/hooks/claude-code-fetch-intercept.mjs \${BUN_OPTIONS}" command claude "\$@"; }'
fi
# loongsuite-pilot END claude-code-intercept
INTERCEPTBLOCK
        msg "    ✅ 已写入 $file (请执行 source $file 或打开新终端)" \
            "    ✅ Written to $file (run: source $file or open a new terminal)"
    }

    case "${SHELL:-/bin/bash}" in
        */zsh)  _inject_to_rc "$HOME/.zshrc" ;;
        */bash) _inject_to_rc "$HOME/.bashrc" ;;
        *)      _inject_to_rc "$HOME/.bashrc" ;;
    esac

    # If the user already defines their own `claude`, our guard skipped the
    # wrapper (to avoid clobbering it), so collection won't run. Tell them how
    # to opt in, since there is otherwise no signal explaining the silence.
    if _rc_user_override_present claude \
        'loongsuite-pilot BEGIN claude-code-intercept' \
        'loongsuite-pilot END claude-code-intercept'; then
        msg "    ⚠️  检测到你已自定义 claude(alias/function)，为避免覆盖，采集未启用。" \
            "    ⚠️  Detected your own 'claude' (alias/function); collection is disabled to avoid clobbering it."
        msg "        如需启用采集，请在你的 claude 定义中加入： BUN_OPTIONS=\"--preload=$DATA_DIR/hooks/claude-code-fetch-intercept.mjs \${BUN_OPTIONS}\"" \
            "        To enable collection, add to your claude definition: BUN_OPTIONS=\"--preload=$DATA_DIR/hooks/claude-code-fetch-intercept.mjs \${BUN_OPTIONS}\""
    fi
    echo ""
}

remove_claude_code_fetch_intercept() {
    for file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        if [ -f "$file" ] && grep -q 'loongsuite-pilot BEGIN claude-code-intercept' "$file" 2>/dev/null; then
            _sed_inplace '/# loongsuite-pilot BEGIN claude-code-intercept/,/# loongsuite-pilot END claude-code-intercept/d' "$file"
            msg "    已清理 claude-code fetch intercept ($file)" \
                "    Cleaned up claude-code fetch intercept ($file)"
        fi
    done
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
# Remove legacy Claude OTel plugin
# ============================================================
remove_otel_plugin() {
    local OTEL_CLAUDE_DIR="$HOME/.cache/opentelemetry.instrumentation.claude"

    # Prevent NODE_OPTIONS --require intercept.js from breaking node commands
    # after the Claude plugin directory (and intercept.js) is deleted
    unset NODE_OPTIONS 2>/dev/null || true

    if [ -f "$OTEL_CLAUDE_DIR/package/scripts/uninstall.sh" ]; then
        bash "$OTEL_CLAUDE_DIR/package/scripts/uninstall.sh" 2>/dev/null || true
        msg "    ✅ Claude Code 插件 hooks 和 alias 已清理" \
            "    ✅ Claude Code plugin hooks and alias cleaned"
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

        # Clean settings.json hooks (fallback when uninstall.sh is unavailable)
        local claude_settings="$HOME/.claude/settings.json"
        if [ -f "$claude_settings" ] && grep -qE "otel-claude-hook|hook-entry\.sh" "$claude_settings" 2>/dev/null && command -v node &>/dev/null; then
            node -e "
const fs = require('fs');
const f = process.argv[1];
const isOurs = c => c.includes('otel-claude-hook') || c.includes('hook-entry.sh');
try {
  const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
  if (d && d.hooks) {
    for (const ev of Object.keys(d.hooks)) {
      if (!Array.isArray(d.hooks[ev])) continue;
      d.hooks[ev] = d.hooks[ev].map(m => {
        if (!Array.isArray(m.hooks)) return m;
        m.hooks = m.hooks.filter(h => !(h.command && isOurs(h.command)));
        return m.hooks.length > 0 ? m : null;
      }).filter(Boolean);
      if (d.hooks[ev].length === 0) delete d.hooks[ev];
    }
    if (Object.keys(d.hooks).length === 0) delete d.hooks;
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
  }
} catch {}
" "$claude_settings" 2>/dev/null || true
            msg "    ✅ settings.json hooks 已清理" "    ✅ settings.json hooks cleaned"
        fi
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
        if [ "$PURGE" -eq 1 ]; then
            rm -rf "$OTEL_CLAUDE_DIR"
            msg "    ✅ 插件目录已完全删除 (--purge): $OTEL_CLAUDE_DIR" \
                "    ✅ Plugin directory fully removed (--purge): $OTEL_CLAUDE_DIR"
        else
            find "$OTEL_CLAUDE_DIR" -maxdepth 1 \
              ! -name sessions \
              ! -name "$(basename "$OTEL_CLAUDE_DIR")" \
              -exec rm -rf {} + 2>/dev/null || true
            msg "    ✅ 插件文件已删除（sessions/ 已保留）" \
                "    ✅ Plugin files removed (sessions/ preserved)"
        fi
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
        msg "SLS 后端: $SLS_ENDPOINT" "SLS backend: $SLS_ENDPOINT"
        [ -n "$SLS_PROJECT" ]  && msg "   项目: $SLS_PROJECT" "   Project: $SLS_PROJECT"
        [ -n "$SLS_LOGSTORE" ] && msg "   日志库: $SLS_LOGSTORE" "   Logstore: $SLS_LOGSTORE"
        echo ""
    fi

    msg "命令:" "Commands:"
    echo "   loongsuite-pilot status   # 查看状态 / Status"
    echo "   loongsuite-pilot info     # 版本与配置 / Version & config"
    echo "============================================================"
}

# >>> pilot-stop-for-deploy >>>
# Overlay `install` used to SIGTERM only the collector pid file. The updater
# stayed up, and gcOldVersions() deletes any versions/<dir> that is not
# current/previous -- including the directory this deploy just copied, before
# current is published. installer-opensource.sh writes current after
# node_modules + postinstall, so that window is minutes. `loongsuite-pilot stop`
# unloads LaunchAgent / disables systemd (autostart_remove) so neither process
# comes back mid-deploy. That is the Unix counterpart of Disable-ScheduledTask.
#
# stop deletes the unit files. restore_pilot_after_deploy (EXIT trap) is the
# counterpart of Enable-ScheduledTask in finally: it re-registers autostart
# via start. Container installs must not start a daemon in the build layer.
#
# Fresh install has no CLI yet. Fall back to both pid files so a leftover
# collector or updater still goes down.
# All CLI after stop must go through run_pilot_cli so --data-dir matches.
PILOT_HELD_FOR_DEPLOY=0

resolve_pilot_cli() {
    if command -v loongsuite-pilot &>/dev/null; then
        command -v loongsuite-pilot
    elif [ -f "$HOME/.local/bin/loongsuite-pilot" ]; then
        printf '%s\n' "$HOME/.local/bin/loongsuite-pilot"
    fi
}

run_pilot_cli() {
    local cli
    cli="$(resolve_pilot_cli)"
    [ -n "$cli" ] || return 1
    # deploy_package writes versions/current under $HOME/.loongsuite-pilot
    # (the CLI cache default). Do not point CACHE_DIR at DATA_DIR.
    LOONGSUITE_PILOT_DATA_DIR="$DATA_DIR" \
        "$cli" "$@"
}

stop_one_pilot_pid_file() {
    local pid_file="$1"
    [ -f "$pid_file" ] || return 0
    local old_pid
    old_pid=$(cat "$pid_file")
    if kill -0 "$old_pid" 2>/dev/null; then
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
    else
        rm -f "$pid_file"
    fi
}

stop_pilot_for_deploy() {
    PILOT_HELD_FOR_DEPLOY=0
    local cli
    cli="$(resolve_pilot_cli)"

    if [ -z "$cli" ] && [ ! -f "$DATA_DIR/loongsuite-pilot.pid" ] && [ ! -f "$DATA_DIR/loongsuite-pilot-updater.pid" ]; then
        return 0
    fi

    msg "==> 停止服务..." "==> Stopping service..."
    if [ -n "$cli" ]; then
        PILOT_HELD_FOR_DEPLOY=1
        if ! run_pilot_cli stop; then
            msg "    ⚠️  无法停止服务，覆盖安装期间 updater 可能仍会 GC" \
                "    ⚠️  Could not stop the service; updater may still GC during this overlay"
        fi
    fi
    # Leftovers: no CLI on PATH, or an updater the CLI did not track.
    stop_one_pilot_pid_file "$DATA_DIR/loongsuite-pilot.pid"
    stop_one_pilot_pid_file "$DATA_DIR/loongsuite-pilot-updater.pid"
    echo ""
}

restore_pilot_after_deploy() {
    [ "${PILOT_HELD_FOR_DEPLOY:-0}" -eq 1 ] || return 0
    [ "${INSTALL_MODE:-host}" = "container" ] && return 0
    PILOT_HELD_FOR_DEPLOY=0
    if ! run_pilot_cli start; then
        msg "    ⚠️  无法恢复自启，请手动运行: loongsuite-pilot start" \
            "    ⚠️  Could not restore autostart, run manually: loongsuite-pilot start"
    fi
}
# <<< pilot-stop-for-deploy <<<

# ============================================================
# CMD: install
# ============================================================
reject_multi_sls_config() {
    installer_config_operation check-config
}

cmd_install() {
    local INSTALL_CONFIG=1
    msg "==> 开始安装 $PACKAGE_NAME ..." \
        "==> Installing $PACKAGE_NAME ..."
    echo ""

    validate_install_user
    check_deps

    # Check if already installed
    local cur_ver; cur_ver=$(get_installed_version)
    if [ -n "$cur_ver" ]; then
        msg "⚠️  检测到已安装版本 v${cur_ver}，将执行重新安装" \
            "⚠️  Existing installation v${cur_ver} detected, re-installing"
        echo ""
    fi

    # Stop collector AND updater, and unload launchd / disable systemd so GC
    # cannot delete the in-flight versions dir. See stop_pilot_for_deploy.
    # Arm restore before stop: autostart_remove is not reversible if we die
    # between stop and trap.
    trap 'restore_pilot_after_deploy; rm -rf "${TMP_DIR:-}"' EXIT
    download_and_extract
    reject_multi_sls_config
    probe_agents
    select_agents
    prompt_user_id
    installer_config_operation validate-config
    confirm_config_overwrite
    prepare_package "$INSTALL_SRC"
    stop_pilot_for_deploy
    migrate_legacy_layout
    # set -e would end the install here anyway; saying why beats an exit code on its own.
    if ! deploy_package "$STAGED_DIR"; then
        echo ""
        msg "❌ 安装中止：hook 脚本部署失败，请检查上方输出后重试" \
            "❌ Install aborted: hook script deployment failed; check the output above and retry"
        exit 1
    fi
    install_loongsuite_pilot_command
    inject_qodercli_token_intercept
    inject_qoderclicn_token_intercept
    inject_claude_code_fetch_intercept

    msg "==> 启动服务..." "==> Starting service..."
    if run_pilot_cli start; then
        sleep 2
        local _status_out
        _status_out="$(run_pilot_cli status 2>/dev/null || true)"
        if echo "$_status_out" | grep -q "is running"; then
            PILOT_HELD_FOR_DEPLOY=0
            msg "    ✅ 服务已启动" "    ✅ Service started"
        else
            msg "    ⚠️  服务可能尚未就绪，请检查: loongsuite-pilot status" \
                "    ⚠️  Service may not be ready. Check: loongsuite-pilot status"
        fi
    else
        msg "    ⚠️  服务启动失败，请手动运行: loongsuite-pilot start" \
            "    ⚠️  Service failed to start, run manually: loongsuite-pilot start"
    fi
    echo ""

    print_summary "install"
}

# ============================================================
# CMD: upgrade
# ============================================================
cmd_upgrade() {
    msg "==> 开始升级 $PACKAGE_NAME ..." \
        "==> Upgrading $PACKAGE_NAME ..."
    echo ""

    validate_install_user

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

    trap 'restore_pilot_after_deploy; rm -rf "${TMP_DIR:-}"' EXIT
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

    prepare_package "$INSTALL_SRC"
    stop_pilot_for_deploy

    # Deploy new version to versions/<ver>_<commit>/
    # Old version stays untouched; deploy_package writes current/previous pointers
    if ! deploy_package "$STAGED_DIR"; then
        echo ""
        msg "⚠️  部署失败，正在回滚到旧版本..." \
            "⚠️  Deployment failed, rolling back to old version..."
        local _rollback_ok=1
        # 原生发布失败已恢复入口；不能再次交换 current/previous。
        if [ "$_rollback_ok" -eq 1 ]; then
            if run_pilot_cli start; then
                PILOT_HELD_FOR_DEPLOY=0
            else
                _rollback_ok=0
            fi
        fi
        if [ "$_rollback_ok" -eq 1 ]; then
            msg "❌ 升级失败（部署/依赖安装出错），已回滚到 v${old_ver:-unknown} 并重启服务" \
                "❌ Upgrade failed (deploy/dependency error), rolled back to v${old_ver:-unknown} and restarted"
        else
            msg "❌ 升级失败且自动回滚未成功，请手动恢复:" \
                "❌ Upgrade failed and auto-rollback did not succeed. Manual recovery:"
            msg "   loongsuite-pilot rollback && loongsuite-pilot start" \
                "   loongsuite-pilot rollback && loongsuite-pilot start"
        fi
        exit 1
    fi
    install_loongsuite_pilot_command

    # Start the new version
    msg "==> 启动新版本..." "==> Starting new version..."
    if run_pilot_cli start; then
        sleep 2
        local _status_out
        _status_out="$(run_pilot_cli status 2>/dev/null || true)"
        if echo "$_status_out" | grep -q "is running"; then
            PILOT_HELD_FOR_DEPLOY=0
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

    run_pilot_cli stop 2>/dev/null || true

    local _rb_ok=1
    run_pilot_cli rollback 2>/dev/null || _rb_ok=0

    if [ "$_rb_ok" -eq 1 ]; then
        if run_pilot_cli start; then
            PILOT_HELD_FOR_DEPLOY=0
            msg "❌ 升级失败，已回滚到 v${old_ver:-unknown}" \
                "❌ Upgrade failed, rolled back to v${old_ver:-unknown}"
            msg "   请检查日志: loongsuite-pilot log" "   Check logs: loongsuite-pilot log"
        else
            msg "❌ 升级失败，已回滚但未能重启服务" \
                "❌ Upgrade failed, rolled back but could not restart"
            msg "   请手动运行: loongsuite-pilot start" \
                "   Run manually: loongsuite-pilot start"
        fi
    else
        msg "❌ 升级失败且回滚未成功，请手动恢复:" \
            "❌ Upgrade failed and rollback did not succeed. Manual recovery:"
        msg "   loongsuite-pilot rollback && loongsuite-pilot start" \
            "   loongsuite-pilot rollback && loongsuite-pilot start"
    fi
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
        "$HOME/.qoder-cn/settings.json"
        "$HOME/.qoderwork/settings.json"
        "$HOME/.qoderworkcn/settings.json"
        "$HOME/.qwenworkcn/settings.json"
        "$HOME/.claude/settings.json"
        "$HOME/.codex/hooks.json"
        "$HOME/.kiro/agents/pilot-kiro.json"
        "$HOME/.qwen/settings.json"
        "$HOME/.workbuddy/settings.json"
    )

    local _has_node=0
    if command -v node &>/dev/null; then
        _has_node=1
    else
        msg "    ⚠️  未找到 Node.js，含 hook 的配置文件将跳过自动清理" \
            "    ⚠️  Node.js not found, config files with hooks will skip auto-cleanup"
    fi

    for cfg in "${configs[@]}"; do
        [ -f "$cfg" ] || continue
        local short="${cfg/#$HOME/\~}"

        local ok=0
        if [ "$_has_node" -eq 1 ]; then
            node -e "
const fs = require('fs');
const cfg = process.argv[1];
const marker = process.argv[2];
try {
  const data = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== 'object') process.exit(0);
  let changed = false;
  const isCodex = cfg.endsWith('/.codex/hooks.json');
  const isPilotCodex = c => typeof c === 'string' && c.includes(marker)
    && new RegExp('(^|[ /])codex-loongsuite-pilot-hook[.](sh|mjs|ps1)([^A-Za-z0-9_.-]|$)', 'i').test(c);
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const candidates = isCodex ? entries.flatMap(e => {
      if (!e || typeof e !== 'object') return [e];
      if (isPilotCodex(e.command)) { changed = true; return []; }
      if (!Array.isArray(e.hooks)) return [e];
      const nested = e.hooks.filter(h => !isPilotCodex(h && h.command));
      if (nested.length === e.hooks.length) return [e];
      changed = true;
      return nested.length ? [{ ...e, hooks: nested }] : [];
    }) : entries;
    const filtered = isCodex ? candidates : candidates.filter(e => {
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
        else
            # Node unavailable: skip auto-cleanup to avoid over-deletion
            if grep -q "$HOOK_MARKER" "$cfg" 2>/dev/null; then
                msg "    ⚠️  跳过: $short (无 Node.js，请手动删除含 $HOOK_MARKER 的 hook 条目)" \
                    "    ⚠️  Skipped: $short (no Node.js, manually remove hook entries containing $HOOK_MARKER)"
            else
                ok=1
            fi
        fi

        if [ "$ok" -eq 1 ]; then
            msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short"
        else
            msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)"
        fi
    done
}

# Grok Build uses a dedicated Pilot-owned hook file. Match the stable entry
# script name instead of the data-dir path so custom LOONGSUITE_PILOT_DATA_DIR
# installations uninstall correctly, while unrelated hooks in the file remain.
remove_grok_build_hook_config() {
    local grok_home="${GROK_HOME:-$HOME/.grok}"
    local cfg="$grok_home/hooks/loongsuite-pilot.json"
    local state_file="$DATA_DIR/deployed-agents.json"
    if command -v node &>/dev/null && [ -f "$state_file" ]; then
        local persisted
        persisted=$(node -e '
const fs = require("fs");
const path = require("path");
try {
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const value = state?.["grok-build"]?.hookSettingsPath;
  if (typeof value === "string" && path.isAbsolute(value)) process.stdout.write(value);
} catch {}
' "$state_file")
        if [ -n "$persisted" ]; then cfg="$persisted"; fi
    fi
    [ -f "$cfg" ] || return 0
    if ! command -v node &>/dev/null; then
        msg "    ⚠️  跳过: ~/.grok/hooks/loongsuite-pilot.json (无 Node.js，请手动清理 Grok Build Pilot hook)" \
            "    ⚠️  Skipped: ~/.grok/hooks/loongsuite-pilot.json (Node.js unavailable; remove the Grok Build Pilot hook manually)"
        return 0
    fi

    local result
    result="$(node -e '
const fs = require("fs");
const cfg = process.argv[1];
const owned = value => typeof value === "string"
  && /(?:^|[\\/])grok-build-loongsuite-pilot-hook\.(?:sh|ps1)(?:"|\s|$)/i.test(value);
try {
  const data = JSON.parse(fs.readFileSync(cfg, "utf8"));
  const hooks = data && typeof data.hooks === "object" && data.hooks ? data.hooks : null;
  if (!hooks) { process.stdout.write("nochange"); process.exit(0); }
  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = [];
    for (const entry of entries) {
      if (owned(entry && entry.command)) { changed = true; continue; }
      if (entry && Array.isArray(entry.hooks)) {
        const nested = entry.hooks.filter(hook => !owned(hook && hook.command));
        if (nested.length !== entry.hooks.length) changed = true;
        if (entry.hooks.length > 0 && nested.length === 0) continue;
        kept.push({ ...entry, hooks: nested });
      } else {
        kept.push(entry);
      }
    }
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (!changed) { process.stdout.write("nochange"); process.exit(0); }
  if (Object.keys(hooks).length === 0) delete data.hooks;
  if (Object.keys(data).length === 0) {
    fs.unlinkSync(cfg);
  } else {
    const tmp = `${cfg}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, cfg);
  }
  process.stdout.write("cleaned");
} catch (error) {
  process.stderr.write(error.message); process.exit(1);
}
' "$cfg" 2>/dev/null || true)"

    if [ "$result" = "cleaned" ] || [ "$result" = "nochange" ]; then
        msg "    ✅ 已清理: ~/.grok/hooks/loongsuite-pilot.json" \
            "    ✅ Cleaned: ~/.grok/hooks/loongsuite-pilot.json"
    else
        msg "    ⚠️  跳过: ~/.grok/hooks/loongsuite-pilot.json (需手动清理)" \
            "    ⚠️  Skipped: ~/.grok/hooks/loongsuite-pilot.json (manual cleanup needed)"
    fi
}

# ============================================================
# Remove the Pilot-owned DeepSeek Harness YAML patch before plugin assets.
# The same helper is invoked by the PowerShell installer.
# ============================================================
remove_dsh_yaml_patch() {
    local plugin_dir="$DATA_DIR/plugins/dsh"
    local cleanup_script="$plugin_dir/cleanup.mjs"
    local node_bin=""
    for pin_file in "$DATA_DIR/node-bin" "$HOME/.loongsuite-pilot/node-bin"; do
        if [ -f "$pin_file" ]; then
            local pinned
            pinned=$(tr -d '\r\n' < "$pin_file")
            if _node_is_suitable "$pinned"; then node_bin="$pinned"; break; fi
        fi
    done
    if [ -z "$node_bin" ]; then node_bin=$(resolve_node) || node_bin=""; fi
    if [ -z "$node_bin" ]; then
        msg "    ❌ 无可用 Node.js，无法安全清理 DSH YAML patch" \
            "    ❌ No usable Node.js; cannot safely remove the DSH YAML patch"
        return 1
    fi

    # DSH_HOME may differ between install and uninstall. Prefer the exact path
    # recorded when Pilot deployed the block, then fall back for legacy state.
    local dsh_home="${DSH_HOME:-$HOME/.dsh}"
    local patch_path="$dsh_home/cordis.patch.yml"
    local state_file="$DATA_DIR/deployed-agents.json"
    if [ -f "$state_file" ]; then
        local persisted_patch
        persisted_patch=$("$node_bin" -e '
const fs = require("fs");
const path = require("path");
try {
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const value = state?.dsh?.dshPatchPath;
  if (typeof value === "string" && path.isAbsolute(value)) process.stdout.write(value);
} catch {}
' "$state_file")
        if [ -n "$persisted_patch" ]; then patch_path="$persisted_patch"; fi
    fi

    if [ ! -f "$cleanup_script" ]; then
        if [ -f "$patch_path" ] && grep -Fq '# BEGIN PILOT-OBSERVABILITY-MANAGED' "$patch_path"; then
            msg "    ❌ DSH 清理脚本缺失，拒绝删除仍被 YAML 引用的插件资产" \
                "    ❌ DSH cleanup helper is missing; refusing to remove plugin assets still referenced by YAML"
            return 1
        fi
        return 0
    fi

    if ! "$node_bin" "$cleanup_script" --patch "$patch_path" --plugin-dir "$plugin_dir"; then
        msg "    ❌ DSH YAML patch 清理失败；卸载已停止，Pilot 资产保持不变" \
            "    ❌ DSH YAML patch cleanup failed; uninstall stopped and Pilot assets were preserved"
        return 1
    fi
    msg "    ✅ 已清理 DSH YAML patch" "    ✅ Cleaned DSH YAML patch"
}

# ============================================================
# Remove plugin-inject specs (OpenCode)
# ============================================================
# OpenCode uses deployMode "plugin-inject": a spec is written into its own
# config file's plugin array, not a shared settings.json. remove_hook_configs
# does not cover it, so clean it here to avoid a dangling spec that points at
# the (possibly purged) data dir.
remove_opencode_plugin() {
    local configs=(
        "$HOME/.config/opencode/opencode.jsonc"
        "$HOME/.config/opencode/opencode.json"
        "$HOME/.config/opencode/config.json"
    )

    for cfg in "${configs[@]}"; do
        [ -f "$cfg" ] || continue
        local short="${cfg/#$HOME/\~}"

        if ! command -v node &>/dev/null; then
            msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
            continue
        fi

        local result
        result=$(node -e "
const fs = require('fs');
const f = process.argv[1];
// Our entries are identified by the pluginId or the plugin file path.
const isOurs = s => typeof s === 'string' && (s.includes('loongsuite-pilot-opencode') || s.includes('plugins/opencode/plugin.mjs'));
const entryStr = e => typeof e === 'string' ? e : (Array.isArray(e) ? String(e[0]) : '');
// JSONC fallback: strip block comments, whole-line // comments, and trailing
// // comments preceded by whitespace. URL values like file:/// are never
// touched because their slashes are not preceded by whitespace.
const stripJsonc = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*\$/gm, '')
  .replace(/[ \t]+\/\/.*\$/gm, '');
try {
  const raw = fs.readFileSync(f, 'utf-8');
  let data, hadComments = false;
  try { data = JSON.parse(raw); }
  catch { data = JSON.parse(stripJsonc(raw)); hadComments = true; }
  const key = Array.isArray(data.plugins) ? 'plugins' : (Array.isArray(data.plugin) ? 'plugin' : null);
  if (!key) { process.stdout.write('nochange'); process.exit(0); }
  const before = data[key].length;
  data[key] = data[key].filter(e => !isOurs(entryStr(e)));
  if (data[key].length === before) { process.stdout.write('nochange'); process.exit(0); }
  if (hadComments) fs.writeFileSync(f + '.bak', raw, 'utf-8');
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  process.stdout.write(hadComments ? 'cleaned-bak' : 'cleaned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
" "$cfg" 2>/dev/null) || result="error"

        case "$result" in
            cleaned)
                msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short" ;;
            cleaned-bak)
                msg "    ✅ 已清理: $short (含注释,原文件备份为 $short.bak)" \
                    "    ✅ Cleaned: $short (had comments, original backed up to $short.bak)" ;;
            nochange)
                : ;;
            *)
                msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" ;;
        esac
    done
}

# Remove only the Hermes directory plugin owned by this Pilot installation.
remove_hermes_plugin() {
    local hermes_home="${HERMES_HOME:-$HOME/.hermes}"
    local default_plugin_dir="$hermes_home/plugins/loongsuite-pilot"
    local state_file="$DATA_DIR/deployed-agents.json"
    local plugin_dir="$default_plugin_dir"

    if ! command -v node &>/dev/null; then
        msg "    ⚠️  跳过: $plugin_dir (无 node,需手动清理)" \
            "    ⚠️  Skipped: $plugin_dir (node unavailable, manual cleanup needed)"
        return 0
    fi

    plugin_dir=$(node -e "
const fs = require('fs');
const path = require('path');
const stateFile = process.argv[1];
let target = process.argv[2];
try {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const recorded = state?.['hermes-agent']?.targetDir;
  if (typeof recorded === 'string' && path.isAbsolute(recorded)) target = recorded;
} catch {}
process.stdout.write(target);
" "$state_file" "$default_plugin_dir" 2>/dev/null) || plugin_dir="$default_plugin_dir"

    local marker="$plugin_dir/.loongsuite-pilot-managed.json"
    [ -f "$marker" ] || return 0

    local ownership
    ownership=$(node -e "
const fs = require('fs');
const path = require('path');
const dir = process.argv[1];
const marker = path.join(dir, '.loongsuite-pilot-managed.json');
try {
  const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (meta.owner !== 'loongsuite-pilot' || meta.agentId !== 'hermes-agent') {
    process.stdout.write('unmanaged');
    process.exit(0);
  }
  process.stdout.write('owned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
" "$plugin_dir" 2>/dev/null) || ownership="error"

    if [ "$ownership" = "owned" ]; then
        local hermes_cli="${HERMES_CLI:-$hermes_home/hermes-agent/venv/bin/hermes}"
        if [ ! -x "$hermes_cli" ] && command -v hermes &>/dev/null; then
            hermes_cli=$(command -v hermes)
        fi
        if [ -x "$hermes_cli" ]; then
            "$hermes_cli" plugins disable loongsuite-pilot >/dev/null 2>&1 || true
        fi
    fi

    local result="$ownership"
    if [ "$ownership" = "owned" ]; then
        result=$(node -e "
const fs = require('fs');
const path = require('path');
const dir = process.argv[1];
const marker = path.join(dir, '.loongsuite-pilot-managed.json');
try {
  const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (meta.owner !== 'loongsuite-pilot' || meta.agentId !== 'hermes-agent') {
    process.stdout.write('unmanaged');
    process.exit(0);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write('cleaned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
" "$plugin_dir" 2>/dev/null) || result="error"
    fi

    case "$result" in
        cleaned)
            msg "    ✅ 已清理: $plugin_dir" "    ✅ Cleaned: $plugin_dir" ;;
        unmanaged)
            msg "    ⚠️  保留未受 Pilot 管理的 Hermes 插件: $plugin_dir" \
                "    ⚠️  Preserved unmanaged Hermes plugin: $plugin_dir" ;;
        *)
            msg "    ⚠️  跳过: $plugin_dir (需手动清理)" \
                "    ⚠️  Skipped: $plugin_dir (manual cleanup needed)" ;;
    esac
}

# ============================================================
# Remove Pi Coding Agent extension injection
# ============================================================
remove_pi_coding_agent_extension() {
    local cfg="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json"
    local state_file="$DATA_DIR/deployed-agents.json"
    if command -v node &>/dev/null && [ -f "$state_file" ]; then
        local persisted
        persisted=$(node -e '
const fs = require("fs");
const path = require("path");
try {
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const value = state?.["pi-coding-agent"]?.pluginInjectConfigPath;
  if (typeof value === "string" && path.isAbsolute(value)) process.stdout.write(value);
} catch {}
' "$state_file")
        if [ -n "$persisted" ]; then cfg="$persisted"; fi
    fi
    local short="${cfg/#$HOME/\~}"
    if ! command -v node &>/dev/null; then
        msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
        return 0
    fi

    local result
    result=$(node -e "
const fs = require('fs');
const path = require('path');
const defaultConfig = process.argv[1];
const dataDir = process.argv[2];
const targets = [{ configPath: defaultConfig, markers: ['loongsuite-pilot-pi-coding-agent', 'plugins/pi-coding-agent/index.mjs'] }];
const resolveValue = value => typeof value === 'string'
  ? value.replace(/^~(?=[\\/])/, process.env.HOME || '').replaceAll('\$PILOT_DATA', dataDir)
  : value;
const stripJsoncComments = text => {
  let result = '';
  let index = 0;
  let inString = false;
  let escape = false;
  while (index < text.length) {
    const ch = text[index];
    if (inString) {
      result += ch;
      if (escape) escape = false;
      else if (ch.charCodeAt(0) === 92) escape = true;
      else if (ch === '\"') inString = false;
      index++;
      continue;
    }
    if (ch === '\"') {
      inString = true;
      result += ch;
      index++;
      continue;
    }
    if (ch === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (ch === '/' && text[index + 1] === '*') {
      index += 2;
      while (index + 1 < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index += 2;
      continue;
    }
    result += ch;
    index++;
  }
  return result;
};
const comparable = value => typeof value === 'string'
  ? value.split(String.fromCharCode(92)).join('/')
  : '';
const localDir = path.join(dataDir, 'agents.d.local');
try {
  for (const name of fs.existsSync(localDir) ? fs.readdirSync(localDir) : []) {
    if (!name.endsWith('.json')) continue;
    let def;
    try { def = JSON.parse(fs.readFileSync(path.join(localDir, name), 'utf8')); } catch { continue; }
    if (def?.piSdk?.schemaVersion !== 1 || !def?.pluginInject?.pluginId?.startsWith('loongsuite-pilot-pi-sdk-')) continue;
    const spec = resolveValue(def.pluginInject.pluginSpec);
    for (const configPath of def.pluginInject.configPaths || []) {
      targets.push({
        configPath: resolveValue(configPath),
        markers: [def.pluginInject.pluginId, spec, 'plugins/pi-coding-agent/agents/'].filter(Boolean),
      });
    }
  }
  let cleaned = 0;
  let skipped = 0;
  for (const target of targets) {
    if (!target.configPath || !fs.existsSync(target.configPath)) continue;
    try {
      const raw = fs.readFileSync(target.configPath, 'utf-8');
      const data = JSON.parse(stripJsoncComments(raw));
      if (!Array.isArray(data.extensions)) continue;
      const before = data.extensions.length;
      data.extensions = data.extensions.filter(entry => {
        const value = comparable(entry);
        return !target.markers.some(marker => value === comparable(marker) || value.includes(comparable(marker)));
      });
      if (data.extensions.length === before) continue;
      if (raw !== JSON.stringify(data, null, 2) + '\n') {
        try {
          fs.copyFileSync(target.configPath, target.configPath + '.bak', fs.constants.COPYFILE_EXCL);
        } catch (e) {
          if (e?.code !== 'EEXIST') throw e;
        }
      }
      fs.writeFileSync(target.configPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      cleaned++;
    } catch {
      skipped++;
    }
  }
  process.stdout.write(cleaned > 0 ? (skipped > 0 ? 'partial' : 'cleaned') : (skipped > 0 ? 'skipped' : 'nochange'));
} catch (e) { process.stderr.write(e.message); process.exit(1); }
" "$cfg" "$DATA_DIR" 2>/dev/null) || result="error"

    case "$result" in
        cleaned)
            msg "    ✅ 已清理 Pi / PI SDK Agent 扩展配置" "    ✅ Cleaned Pi / PI SDK Agent extension configs" ;;
        partial)
            msg "    ⚠️  已清理可读取的 Pi 配置，部分损坏配置需手动清理" \
                "    ⚠️  Cleaned readable Pi configs; some invalid configs need manual cleanup" ;;
        skipped)
            msg "    ⚠️  Pi 配置损坏，需手动清理" "    ⚠️  Invalid Pi configs skipped (manual cleanup needed)" ;;
        nochange)
            : ;;
        *)
            msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" ;;
    esac
}

# ============================================================
# MiMo Code also uses deployMode "plugin-inject": a spec is written into its
# own config file's plugin array. Same shape as remove_opencode_plugin but for
# ~/.config/mimocode/mimocode.json[c]. Without this, the spec survives
# uninstall and points at a (possibly purged) plugin.mjs, so the next MiMo
# Code launch loads a non-existent module.
# ============================================================
remove_mimocode_plugin() {
    local configs=(
        "$HOME/.config/mimocode/mimocode.jsonc"
        "$HOME/.config/mimocode/mimocode.json"
    )

    for cfg in "${configs[@]}"; do
        [ -f "$cfg" ] || continue
        local short="${cfg/#$HOME/\~}"

        if ! command -v node &>/dev/null; then
            msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
            continue
        fi

        local result
        result=$(node -e "
const fs = require('fs');
const f = process.argv[1];
const isOurs = s => typeof s === 'string' && (s.includes('loongsuite-pilot-mimo-code') || s.includes('plugins/mimo-code/plugin.mjs'));
const entryStr = e => typeof e === 'string' ? e : (Array.isArray(e) ? String(e[0]) : '');
const stripJsonc = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*\$/gm, '')
  .replace(/[ \t]+\/\/.*\$/gm, '');
try {
  const raw = fs.readFileSync(f, 'utf-8');
  let data, hadComments = false;
  try { data = JSON.parse(raw); }
  catch { data = JSON.parse(stripJsonc(raw)); hadComments = true; }
  const key = Array.isArray(data.plugins) ? 'plugins' : (Array.isArray(data.plugin) ? 'plugin' : null);
  if (!key) { process.stdout.write('nochange'); process.exit(0); }
  const before = data[key].length;
  data[key] = data[key].filter(e => !isOurs(entryStr(e)));
  if (data[key].length === before) { process.stdout.write('nochange'); process.exit(0); }
  if (hadComments) fs.writeFileSync(f + '.bak', raw, 'utf-8');
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  process.stdout.write(hadComments ? 'cleaned-bak' : 'cleaned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
" "$cfg" 2>/dev/null) || result="error"

        case "$result" in
            cleaned)
                msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short" ;;
            cleaned-bak)
                msg "    ✅ 已清理: $short (含注释,原文件备份为 $short.bak)" \
                    "    ✅ Cleaned: $short (had comments, original backed up to $short.bak)" ;;
            nochange)
                : ;;
            *)
                msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" ;;
        esac
    done
}

# ============================================================
# Remove OpenClaw's nested plugin entry and load path.
# ============================================================
# OpenClaw stores injected plugins under plugins.load.paths plus
# plugins.entries. The generic hook cleanup does not cover this shape, and
# leaving either value behind makes OpenClaw load a path that uninstall is
# about to remove. Only Pilot-owned values are removed; unrelated plugins and
# their configuration remain semantically unchanged.
remove_openclaw_plugin() {
    local state_dir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    local managed_path="$DATA_DIR/plugins/openclaw"
    local configs=()
    [ -n "${OPENCLAW_CONFIG_PATH:-}" ] && configs+=("$OPENCLAW_CONFIG_PATH")
    configs+=(
        "$state_dir/openclaw.json"
        "$state_dir/config.json"
        "$HOME/.openclaw/openclaw.json"
        "$HOME/.openclaw/config.json"
    )

    local seen="|"
    for cfg in "${configs[@]}"; do
        [ -f "$cfg" ] || continue
        case "$seen" in *"|$cfg|"*) continue ;; esac
        seen="${seen}${cfg}|"
        local short="${cfg/#$HOME/\~}"

        if ! command -v node &>/dev/null; then
            msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
            continue
        fi

        local result
        result=$(PILOT_OC_CONFIG="$cfg" PILOT_OC_MANAGED="$managed_path" node 2>/dev/null <<'NODE'
const fs = require('fs');
const f = process.env.PILOT_OC_CONFIG;
const managed = process.env.PILOT_OC_MANAGED.replaceAll('\\', '/');
const entryStr = value => typeof value === 'string'
  ? value
  : (Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '');
const isOurs = value => {
  const normalized = entryStr(value).replaceAll('\\', '/');
  const plain = normalized.startsWith('file://') ? normalized.slice('file://'.length) : normalized;
  return plain === managed ||
    plain === managed + '/plugin.mjs' ||
    normalized.includes('loongsuite-pilot-openclaw') ||
    normalized.includes('plugins/openclaw/plugin.mjs') && plain.includes('.loongsuite-pilot/');
};
try {
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
  let changed = false;
  for (const key of ['plugin', 'plugins']) {
    if (!Array.isArray(data[key])) continue;
    const filtered = data[key].filter(value => !isOurs(value));
    if (filtered.length !== data[key].length) { data[key] = filtered; changed = true; }
  }
  const plugins = data.plugins && typeof data.plugins === 'object' && !Array.isArray(data.plugins)
    ? data.plugins
    : null;
  if (plugins) {
    if (plugins.load && typeof plugins.load === 'object' && Array.isArray(plugins.load.paths)) {
      const filtered = plugins.load.paths.filter(value => !isOurs(value));
      if (filtered.length !== plugins.load.paths.length) { plugins.load.paths = filtered; changed = true; }
    }
    if (plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries) &&
        Object.prototype.hasOwnProperty.call(plugins.entries, 'loongsuite-pilot-openclaw')) {
      delete plugins.entries['loongsuite-pilot-openclaw'];
      changed = true;
    }
  }
  if (!changed) { process.stdout.write('nochange'); process.exit(0); }
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  process.stdout.write('cleaned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
NODE
) || result="error"

        case "$result" in
            cleaned)
                msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short" ;;
            nochange)
                : ;;
            *)
                msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" ;;
        esac
    done
}

# ============================================================
# CMD: uninstall
# ============================================================
# Resolve and validate the cleanup runtime before any service or asset removal.
# Legacy installs can explicitly supply a Rust candidate with --package-url.
prepare_native_uninstall() {
    local cache_dir="${LOONGSUITE_PILOT_CACHE_DIR:-$HOME/.loongsuite-pilot}"
    local checked_cache="$cache_dir" checked_home="$HOME"
    if [ -d "$cache_dir" ]; then checked_cache="$(cd "$cache_dir" && pwd -P)"; fi
    if [ -d "$HOME" ]; then checked_home="$(cd "$HOME" && pwd -P)"; fi
    if [ "$checked_cache" = / ] || [ "$checked_cache" = "$checked_home" ]; then
        printf '%s\n' '拒绝不安全的卸载缓存目录；安装文件已保留' >&2
        return 1
    fi
    if [ -n "${PACKAGE_URL:-}" ]; then
        download_and_extract
    elif [ -z "${INSTALL_SRC:-}" ]; then
        local version=""
        if [ -f "$cache_dir/current" ]; then version="$(< "$cache_dir/current")"; fi
        case "$version" in
            ""|.|..|*[!a-zA-Z0-9._-]*)
                printf '%s\n' '找不到原生卸载入口；请通过 --package-url 指定 Rust 候选包，安装文件已保留' >&2
                return 1
                ;;
        esac
        INSTALL_SRC="$cache_dir/versions/$version"
    fi
    cleanup_native_agents --check-only
}

cleanup_native_agents() {
    local flags=()
    if [ "${PURGE:-0}" -eq 1 ]; then flags+=(--purge); fi
    native_installer_helper cleanup-agents --data-dir "$DATA_DIR" --pilot-dir "$INSTALL_SRC" \
        ${flags[@]+"${flags[@]}"} "$@" >/dev/null
}

cmd_uninstall() {
    msg "🗑️  开始卸载 $PACKAGE_NAME ..." \
        "🗑️  Uninstalling $PACKAGE_NAME ..."
    echo ""

    prepare_native_uninstall

    # Stop service (also removes autostart)
    msg "==> 停止服务..." "==> Stopping service..."
    if command -v loongsuite-pilot &>/dev/null; then
        loongsuite-pilot stop 2>/dev/null || true
    elif [ -f "$HOME/.local/bin/loongsuite-pilot" ]; then
        "$HOME/.local/bin/loongsuite-pilot" stop 2>/dev/null || true
    else
        local pid_file="$DATA_DIR/loongsuite-pilot.pid"
        if [ -f "$pid_file" ]; then
            local pid; pid=$(cat "$pid_file")
            kill "$pid" 2>/dev/null || true
            sleep 2
            kill -9 "$pid" 2>/dev/null || true
            rm -f "$pid_file"
        fi
        # Manual autostart cleanup when loongsuite-pilot is unavailable
        case "$(uname -s)" in
            Darwin)
                local _plist="$HOME/Library/LaunchAgents/com.loongsuite-pilot.plist"
                local _uplist="$HOME/Library/LaunchAgents/com.loongsuite-pilot.updater.plist"
                for f in "$_uplist" "$_plist"; do
                    if [ -f "$f" ]; then
                        launchctl unload -w "$f" 2>/dev/null || true
                        rm -f "$f"
                    fi
                done
                ;;
            Linux)
                local _run_user
                _run_user="$(whoami)"

                # Clean up user-level systemd units
                local _user_unit_dir="$HOME/.config/systemd/user"
                if [ -f "$_user_unit_dir/loongsuite-pilot.service" ]; then
                    systemctl --user disable --now loongsuite-pilot.service &>/dev/null || true
                    systemctl --user disable --now loongsuite-pilot-updater.service &>/dev/null || true
                    rm -f "$_user_unit_dir/loongsuite-pilot.service"
                    rm -f "$_user_unit_dir/loongsuite-pilot-updater.service"
                    systemctl --user daemon-reload &>/dev/null || true
                fi

                # Clean up system-level systemd units
                local _sys_unit="/etc/systemd/system/loongsuite-pilot-${_run_user}.service"
                local _sys_uunit="/etc/systemd/system/loongsuite-pilot-updater-${_run_user}.service"
                for f in "$_sys_uunit" "$_sys_unit"; do
                    if [ -f "$f" ]; then
                        sudo systemctl disable --now "$(basename "$f")" &>/dev/null || true
                        sudo rm -f "$f"
                    fi
                done
                sudo systemctl daemon-reload &>/dev/null || true

                # Clean up init.d scripts
                local _initd="/etc/init.d/loongsuite-pilot-${_run_user}"
                local _initd_u="/etc/init.d/loongsuite-pilot-updater-${_run_user}"
                for f in "$_initd_u" "$_initd"; do
                    if [ -f "$f" ]; then
                        sudo "$f" stop &>/dev/null || true
                        local _name; _name=$(basename "$f")
                        if command -v chkconfig &>/dev/null; then sudo chkconfig --del "$_name" &>/dev/null || true
                        elif command -v update-rc.d &>/dev/null; then sudo update-rc.d "$_name" remove &>/dev/null || true; fi
                        sudo rm -f "$f"
                    fi
                done
                ;;
        esac
    fi
    msg "    ✅ 服务已停止" "    ✅ Service stopped"
    echo ""

    msg "==> 原生清理 Agent 与历史插件配置..." "==> Cleaning Agent and legacy plugin configuration..."
    cleanup_native_agents
    remove_qodercli_token_intercept
    remove_qoderclicn_token_intercept
    remove_claude_code_fetch_intercept
    echo ""

    # Remove installation artifacts
    msg "==> 删除安装目录..." "==> Removing installation..."
    local _cache_dir="${LOONGSUITE_PILOT_CACHE_DIR:-$HOME/.loongsuite-pilot}"
    rm -rf "${_cache_dir:?}/versions"
    rm -rf "${_cache_dir:?}/bin"
    rm -rf "${_cache_dir:?}/package"
    rm -f "${_cache_dir:?}/current"
    rm -f "${_cache_dir:?}/previous"
    rm -f "${_cache_dir:?}/node-bin"
    msg "    ✅ 已删除安装文件" "    ✅ Installation files removed"

    # Remove loongsuite-pilot command
    msg "==> 删除 loongsuite-pilot 命令..." "==> Removing loongsuite-pilot command..."
    rm -f "$HOME/.local/bin/loongsuite-pilot"
    rm -f /usr/local/bin/loongsuite-pilot 2>/dev/null || true
    msg "    ✅ loongsuite-pilot 命令已删除" "    ✅ loongsuite-pilot command removed"
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
