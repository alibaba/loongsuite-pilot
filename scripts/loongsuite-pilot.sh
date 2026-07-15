#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
CACHE_DIR="${LOONGSUITE_PILOT_CACHE_DIR:-$HOME/.loongsuite-pilot}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS_DIR="$CACHE_DIR/versions"
CURRENT_FILE="$CACHE_DIR/current"
PREVIOUS_FILE="$CACHE_DIR/previous"
BOOTSTRAP_DIR="$CACHE_DIR/bin"
PACKAGE_DIR="$CACHE_DIR/package"
PID_FILE="$DATA_DIR/loongsuite-pilot.pid"
UPDATER_PID_FILE="$DATA_DIR/loongsuite-pilot-updater.pid"
LOG_DIR="$DATA_DIR/logs"
LOG_FILE="$LOG_DIR/loongsuite-pilot-service.log"
UPDATER_LOG_FILE="$LOG_DIR/loongsuite-pilot-updater.log"
MONITOR_LOG_FILE="$LOG_DIR/loongsuite-pilot-monitor-process.log"
DASHBOARD_LOG_FILE="$LOG_DIR/loongsuite-pilot-dashboard.log"
CONFIG_FILE="$DATA_DIR/config.json"
SPAN_ATTR_FILE="$DATA_DIR/span-attributes.json"
MONITOR_PID_FILE="$DATA_DIR/loongsuite-pilot-monitor.pid"
DASHBOARD_PID_FILE="$DATA_DIR/loongsuite-pilot-dashboard.pid"
MONITOR_DATA_DIR="$LOG_DIR/process-monitor"

SERVICE_LABEL="com.loongsuite-pilot"
UPDATER_LABEL="com.loongsuite-pilot.updater"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
UPDATER_PLIST="$HOME/Library/LaunchAgents/${UPDATER_LABEL}.plist"
SYSTEMD_SYSTEM_UNIT_DIR="/etc/systemd/system"
LOONGSUITE_PILOT_BIN="$HOME/.local/bin/loongsuite-pilot"
INIT_TYPE_FILE="$DATA_DIR/init-type"

validate_current_user() {
    whoami
}

has_sudo_interactive() {
    [ "$(id -u)" -eq 0 ] && return 0
    if sudo -n true 2>/dev/null; then
        return 0
    elif sudo -v 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

has_sudo_noninteractive() {
    [ "$(id -u)" -eq 0 ] && return 0
    sudo -n true 2>/dev/null
}

resolve_user_home() {
    local user="$1"
    if command -v getent &>/dev/null; then
        getent passwd "$user" 2>/dev/null | cut -d: -f6
    else
        eval echo "~$user" 2>/dev/null
    fi
}

ensure_dirs() {
    mkdir -p "$LOG_DIR"
    mkdir -p "$BOOTSTRAP_DIR"
}

sync_bootstrap_scripts() {
    local version_dir
    version_dir=$(resolve_current_version 2>/dev/null) || true
    if [ -z "$version_dir" ]; then return; fi
    local src_dir="$version_dir/scripts"
    if [ ! -f "$src_dir/collector-daemon.js" ]; then return; fi
    mkdir -p "$BOOTSTRAP_DIR"
    cp -f "$src_dir/collector-daemon.js" "$BOOTSTRAP_DIR/"
    cp -f "$src_dir/updater-daemon.js"   "$BOOTSTRAP_DIR/" 2>/dev/null || true
}

sync_installed_scripts_from_version() {
    local version_dir="$1"
    local src_dir="$version_dir/scripts"
    if [ ! -f "$src_dir/collector-daemon.js" ] || [ ! -f "$src_dir/updater-daemon.js" ] || [ ! -f "$src_dir/loongsuite-pilot.sh" ]; then
        return 1
    fi

    mkdir -p "$BOOTSTRAP_DIR"
    cp -f "$src_dir/collector-daemon.js" "$BOOTSTRAP_DIR/collector-daemon.js.tmp"
    mv -f "$BOOTSTRAP_DIR/collector-daemon.js.tmp" "$BOOTSTRAP_DIR/collector-daemon.js"
    cp -f "$src_dir/updater-daemon.js" "$BOOTSTRAP_DIR/updater-daemon.js.tmp"
    mv -f "$BOOTSTRAP_DIR/updater-daemon.js.tmp" "$BOOTSTRAP_DIR/updater-daemon.js"

    mkdir -p "$(dirname "$LOONGSUITE_PILOT_BIN")"
    cp -f "$src_dir/loongsuite-pilot.sh" "$LOONGSUITE_PILOT_BIN.tmp"
    chmod 755 "$LOONGSUITE_PILOT_BIN.tmp"
    mv -f "$LOONGSUITE_PILOT_BIN.tmp" "$LOONGSUITE_PILOT_BIN"
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

is_pid_file_running() {
    local pid_file="$1"
    if [ -f "$pid_file" ]; then
        local pid
        pid=$(cat "$pid_file" 2>/dev/null || true)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        rm -f "$pid_file"
    fi
    return 1
}

stop_pid_file() {
    local pid_file="$1"
    if is_pid_file_running "$pid_file"; then
        local pid
        pid=$(cat "$pid_file")
        kill "$pid" 2>/dev/null || true
        local count=0
        while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
            sleep 1
            count=$((count + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    fi
    rm -f "$pid_file"
}

updater_process_exists() {
    if [ -f "$UPDATER_PID_FILE" ]; then
        local pid
        pid=$(cat "$UPDATER_PID_FILE" 2>/dev/null || true)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            local command_line
            command_line=$(ps -p "$pid" -o command= 2>/dev/null || true)
            case "$command_line" in
                *updater-daemon.js*|*"/bin/updater-daemon"*|*"loongsuite-pilot run-updater"*|*"dist/updater/index.js"*)
                    return 0
                    ;;
            esac
        fi
    fi

    pgrep -f "loongsuite-pilot/bin/updater-daemon" >/dev/null 2>&1
}

_node_is_suitable() {
    local bin="$1"
    [ -x "$bin" ] || return 1
    _node_is_app_bundle "$bin" && return 1
    local ver
    ver="$("$bin" --version 2>/dev/null)" || return 1
    local major="${ver#v}"
    major="${major%%.*}"
    [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 18 )) || return 1
    return 0
}

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

NODE_PIN_FILE="$CACHE_DIR/node-bin"

resolve_node() {
    # 1. Pinned file
    if [ -f "$NODE_PIN_FILE" ]; then
        local pinned
        pinned=$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$pinned" ] && _node_is_suitable "$pinned"; then
            echo "$pinned"
            return 0
        fi
    fi

    # 2. Fallback search: prefer user-managed Node over app-bundled PATH shims.
    local _candidates=()

    # nvm (descending — newest first)
    local _nvm_candidates=("$HOME/.nvm/versions/node"/*/bin/node)
    local i
    for (( i=${#_nvm_candidates[@]}-1; i>=0; i-- )); do
        _candidates+=("${_nvm_candidates[i]}")
    done

    # volta, fnm, homebrew, local
    _candidates+=(
        "$HOME/.volta/bin/node"
        "$HOME/.fnm/aliases/default/bin/node"
        /opt/homebrew/bin/node
        /usr/local/bin/node
        "$HOME/.local/bin/node"
    )

    # PATH is last because shells launched by apps may expose bundled Node runtimes.
    if command -v node >/dev/null 2>&1; then
        _candidates+=("$(command -v node)")
    fi

    for candidate in "${_candidates[@]}"; do
        if _node_is_suitable "$candidate"; then
            # Auto-heal: update pin file
            local resolved
            resolved=$(_resolve_realpath "$candidate")
            mkdir -p "$(dirname "$NODE_PIN_FILE")" 2>/dev/null || true
            echo "$resolved" > "$NODE_PIN_FILE" 2>/dev/null || true
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

_detect_system_level_init() {
    if [ -d /run/systemd/system ] && command -v systemctl &>/dev/null; then
        echo "systemd-system"
    elif [ -d /etc/init.d ]; then
        echo "initd"
    else
        echo "none"
    fi
}

detect_init_system() {
    local interactive="${1:-true}"

    if [ -f "$INIT_TYPE_FILE" ]; then
        local saved
        saved=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
        case "$saved" in
            launchd|systemd-user|systemd-system|initd)
                echo "$saved"
                return
                ;;
        esac
    fi
    case "$(uname -s)" in
        Darwin) echo "launchd" ;;
        Linux)
            if [ "$(id -u)" -eq 0 ]; then
                _detect_system_level_init
            else
                if command -v systemctl &>/dev/null && systemctl --user show-environment &>/dev/null 2>&1; then
                    echo "systemd-user"
                elif [ "$interactive" = "true" ] && has_sudo_interactive; then
                    _detect_system_level_init
                elif [ "$interactive" = "false" ] && has_sudo_noninteractive; then
                    _detect_system_level_init
                else
                    echo "none"
                fi
            fi
            ;;
        *) echo "none" ;;
    esac
}

enable_linger() {
    local user
    user="$(whoami)"
    if loginctl enable-linger "$user" 2>/dev/null; then
        echo "✓ Linger enabled — service will persist after logout."
        return 0
    else
        echo "⚠️  Cannot enable linger (requires polkit policy or root privilege)." >&2
        echo "   Service may stop when you log out." >&2
        echo "   To fix: run 'sudo loginctl enable-linger $user'." >&2
        return 1
    fi
}

is_managed_by_launchd() {
    [ -f "$LAUNCHD_PLIST" ] && launchctl list "$SERVICE_LABEL" &>/dev/null
}

is_managed_by_systemd_user() {
    systemctl --user is-enabled loongsuite-pilot.service &>/dev/null
}

is_managed_by_systemd_system() {
    local user
    user=$(whoami)
    local unit_name="loongsuite-pilot-${user}.service"
    [ -f "/etc/systemd/system/$unit_name" ] && sudo -n systemctl is-enabled "$unit_name" &>/dev/null
}

is_managed_by_initd() {
    local user
    user=$(whoami)
    [ -f "/etc/init.d/loongsuite-pilot-${user}" ]
}



resolve_current_version() {
    if [ -f "$CURRENT_FILE" ]; then
        local dir
        dir=$(cat "$CURRENT_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$dir" ] && [ -d "$VERSIONS_DIR/$dir" ]; then
            echo "$VERSIONS_DIR/$dir"
            return 0
        fi
    fi
    if [ -d "$PACKAGE_DIR" ] && [ -f "$PACKAGE_DIR/dist/index.js" ]; then
        echo "$PACKAGE_DIR"
        return 0
    fi
    return 1
}

resolve_previous_version() {
    if [ -f "$PREVIOUS_FILE" ]; then
        local dir
        dir=$(cat "$PREVIOUS_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$dir" ] && [ -d "$VERSIONS_DIR/$dir" ]; then
            echo "$VERSIONS_DIR/$dir"
            return 0
        fi
    fi
    return 1
}

resolve_script() {
    local script_name="$1"
    local version_dir
    version_dir=$(resolve_current_version 2>/dev/null) || true
    for base in "$version_dir" "$PACKAGE_DIR" "$(dirname "$SCRIPT_DIR")"; do
        if [ -n "$base" ] && [ -f "$base/scripts/$script_name" ]; then
            echo "$base/scripts/$script_name"
            return 0
        fi
    done
    return 1
}

# ---- Internal: run in foreground (used by launchd / systemd) ----

cmd_run() {
    ensure_dirs
    sync_bootstrap_scripts

    if [ ! -f "$BOOTSTRAP_DIR/collector-daemon.js" ]; then
        echo "❌ Bootstrap script missing" >&2
        exit 1
    fi

    local node_bin
    node_bin=$(resolve_node) || {
        echo "❌ node runtime not found" >&2
        exit 1
    }

    echo "$$" > "$PID_FILE"
    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
    exec "$node_bin" "$BOOTSTRAP_DIR/collector-daemon.js"
}

cmd_run_updater() {
    ensure_dirs
    sync_bootstrap_scripts

    if [ ! -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
        exit 0
    fi

    local node_bin
    node_bin=$(resolve_node) || {
        echo "❌ node runtime not found" >&2
        exit 1
    }

    echo "$$" > "$UPDATER_PID_FILE"
    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
    exec "$node_bin" "$BOOTSTRAP_DIR/updater-daemon.js"
}

# ---- User-facing commands ----

cmd_start() {
    for arg in "$@"; do
        case "$arg" in
            --system-service)
                echo "⚠️  --system-service is deprecated and ignored. Auto-detection is now the default." >&2
                ;;
        esac
    done

    if is_running; then
        echo "✅ loongsuite-pilot is already running (PID $(cat "$PID_FILE"))"
        return 0
    fi

    ensure_dirs
    sync_bootstrap_scripts

    if autostart_install "true"; then
        sleep 2
        if is_running; then
            local init_type
            init_type=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
            echo "✅ loongsuite-pilot started ($init_type)"
            return 0
        fi
        local init_type
        init_type=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
        echo "⚠️  Service registered (${init_type:-unknown}) but collector process not found after 2s. Check logs: $LOG_FILE" >&2
        echo "   Autostart is configured; the service manager will keep retrying." >&2
        return 0
    fi

    echo "❌ Failed to register system service." >&2
    echo "   No supported init system could be configured." >&2
    case "$(uname -s)" in
        Linux)
            echo "   Tried: systemd-user, systemd-system, init.d" >&2
            echo "   Possible causes:" >&2
            echo "     - No systemd user session (XDG_RUNTIME_DIR not set)" >&2
            echo "     - No sudo access for system-level service" >&2
            echo "     - Container without init system or /etc/init.d" >&2
            ;;
    esac
    exit 1
}

cmd_stop() {
    cmd_monitor_stop >/dev/null 2>&1 || true
    autostart_remove 2>/dev/null || true

    local target_user
    target_user=$(whoami)
    local init_type=""
    if [ -f "$INIT_TYPE_FILE" ]; then
        init_type=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
    fi

    case "$(uname -s)" in
        Darwin)
            launchctl stop "$SERVICE_LABEL" 2>/dev/null || true
            launchctl stop "$UPDATER_LABEL" 2>/dev/null || true
            ;;
        Linux)
            case "$init_type" in
                systemd-user)
                    systemctl --user stop loongsuite-pilot.service &>/dev/null || true
                    systemctl --user stop loongsuite-pilot-updater.service &>/dev/null || true
                    ;;
                systemd-system|systemd)
                    sudo systemctl stop "loongsuite-pilot-${target_user}.service" &>/dev/null || true
                    sudo systemctl stop "loongsuite-pilot-updater-${target_user}.service" &>/dev/null || true
                    ;;
                initd)
                    [ -f "/etc/init.d/loongsuite-pilot-${target_user}" ] && sudo "/etc/init.d/loongsuite-pilot-${target_user}" stop &>/dev/null || true
                    [ -f "/etc/init.d/loongsuite-pilot-updater-${target_user}" ] && sudo "/etc/init.d/loongsuite-pilot-updater-${target_user}" stop &>/dev/null || true
                    ;;
            esac
            ;;
    esac

    # Stop PID-file tracked process
    if is_running; then
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
    fi

    # Stop updater PID-file tracked process
    stop_pid_file "$UPDATER_PID_FILE"

    # Kill any remaining orphan processes
    pkill -f "loongsuite-pilot/bin/collector-daemon" 2>/dev/null || true
    pkill -f "loongsuite-pilot/bin/updater-daemon" 2>/dev/null || true

    rm -f "$PID_FILE"
    echo "✅ loongsuite-pilot stopped"
}

cmd_process_monitor_start() {
    if is_pid_file_running "$MONITOR_PID_FILE"; then
        echo "✅ loongsuite-pilot process monitor is already running (PID $(cat "$MONITOR_PID_FILE"))"
        return 0
    fi

    ensure_dirs
    local script
    script=$(resolve_script "monitor-loongsuite-pilot.sh") || {
        echo "❌ monitor script missing"
        exit 1
    }

    nohup bash "$script" >> "$MONITOR_LOG_FILE" 2>&1 &
    echo "$!" > "$MONITOR_PID_FILE"
    echo "✅ loongsuite-pilot process monitor started (PID $!)"
}

cmd_process_monitor_stop() {
    stop_pid_file "$MONITOR_PID_FILE"
    pkill -f "monitor-loongsuite-pilot\.sh" 2>/dev/null || true
    echo "✅ loongsuite-pilot process monitor stopped"
}

cmd_dashboard_start() {
    if is_pid_file_running "$DASHBOARD_PID_FILE"; then
        echo "✅ loongsuite-pilot dashboard is already running (PID $(cat "$DASHBOARD_PID_FILE"))"
        return 0
    fi

    ensure_dirs
    local script node_bin
    script=$(resolve_script "serve-loongsuite-pilot-monitor.mjs") || {
        echo "❌ dashboard script missing"
        exit 1
    }
    node_bin=$(resolve_node) || {
        echo "❌ node runtime not found" >&2
        exit 1
    }

    nohup "$node_bin" "$script" >> "$DASHBOARD_LOG_FILE" 2>&1 &
    echo "$!" > "$DASHBOARD_PID_FILE"
    echo "✅ loongsuite-pilot dashboard started (PID $!)"
    echo "   open http://127.0.0.1:${LOONGSUITE_PILOT_MONITOR_PORT:-8765}/"
}

cmd_dashboard_stop() {
    stop_pid_file "$DASHBOARD_PID_FILE"
    pkill -f "serve-loongsuite-pilot-monitor\.mjs" 2>/dev/null || true
    echo "✅ loongsuite-pilot dashboard stopped"
}

cmd_monitor_start() {
    cmd_process_monitor_start
    cmd_dashboard_start
    echo "✅ loongsuite-pilot monitor is running"
    echo "   dashboard: http://127.0.0.1:${LOONGSUITE_PILOT_MONITOR_PORT:-8765}/"
}

cmd_monitor_stop() {
    cmd_dashboard_stop
    cmd_process_monitor_stop
    echo "✅ loongsuite-pilot monitor stopped"
}

# Restart only the collector (used by updater after deploying a new version)
cmd_restart_collector() {
    local target_user
    target_user=$(whoami)
    local sys_unit="loongsuite-pilot-${target_user}.service"
    local initd_script="/etc/init.d/loongsuite-pilot-${target_user}"
    local init_type=""
    if [ -f "$INIT_TYPE_FILE" ]; then
        init_type=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
    fi

    # Stop collector only (leave updater running)
    case "$(uname -s)" in
        Darwin)
            launchctl stop "$SERVICE_LABEL" 2>/dev/null || true
            ;;
        Linux)
            case "$init_type" in
                systemd-user)
                    systemctl --user stop loongsuite-pilot.service &>/dev/null || true
                    ;;
                systemd-system|systemd)
                    sudo systemctl stop "$sys_unit" &>/dev/null || true
                    ;;
                initd)
                    [ -f "$initd_script" ] && sudo "$initd_script" stop &>/dev/null || true
                    ;;
            esac
            ;;
    esac
    pkill -f "loongsuite-pilot/bin/collector-daemon" 2>/dev/null || true

    if is_running; then
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
    fi

    sleep 1

    ensure_dirs
    sync_bootstrap_scripts

    local _restarted=false
    case "$(uname -s)" in
        Darwin)
            if launchctl list "$SERVICE_LABEL" &>/dev/null; then
                launchctl start "$SERVICE_LABEL" 2>/dev/null || true
                echo "✅ collector restarted (launchd)"
                _restarted=true
            fi
            ;;
        Linux)
            case "$init_type" in
                systemd-user)
                    if systemctl --user is-enabled loongsuite-pilot.service &>/dev/null; then
                        systemctl --user start loongsuite-pilot.service &>/dev/null
                        echo "✅ collector restarted (systemd user-level)"
                        _restarted=true
                    fi
                    ;;
                systemd-system|systemd)
                    if [ -f "$SYSTEMD_SYSTEM_UNIT_DIR/$sys_unit" ] && sudo -n systemctl is-enabled "$sys_unit" &>/dev/null; then
                        sudo systemctl start "$sys_unit" &>/dev/null
                        echo "✅ collector restarted (systemd system-level)"
                        _restarted=true
                    fi
                    ;;
                initd)
                    if [ -f "$initd_script" ]; then
                        sudo "$initd_script" start &>/dev/null
                        echo "✅ collector restarted (init.d)"
                        _restarted=true
                    fi
                    ;;
            esac
            ;;
    esac
    if [ "$_restarted" = true ]; then
        sleep 1
        if ! is_running; then
            echo "⚠️  service manager reported success but collector process not found"
            _restarted=false
        fi
    fi
    if [ "$_restarted" = false ]; then
        # Self-healing: try to register a proper service for degraded (nohup/unknown) installs
        case "$init_type" in
            nohup|unknown|"")
                local _new_init
                _new_init=$(detect_init_system "false")
                if [ "$_new_init" != "none" ]; then
                    if autostart_install_collector_only "false" 2>>"$LOG_FILE"; then
                        sleep 1
                        if is_running; then
                            echo "✅ collector self-healed: registered as $_new_init"
                            _restarted=true
                        else
                            echo "⚠️  collector self-heal registered ($_new_init) but process not found" >&2
                        fi
                    fi
                fi
                if [ "$_restarted" = false ]; then
                    local entry="$BOOTSTRAP_DIR/collector-daemon.js"
                    if [ ! -f "$entry" ]; then
                        echo "❌ Bootstrap script missing"
                        exit 1
                    fi
                    local node_bin
                    node_bin=$(resolve_node) || {
                        echo "❌ node runtime not found" >&2
                        exit 1
                    }
                    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
                    nohup "$node_bin" "$entry" >> "$LOG_FILE" 2>&1 &
                    echo "$!" > "$PID_FILE"
                    echo "⚠️  collector restarted (nohup fallback, self-heal failed)"
                fi
                ;;
            *)
                echo "❌ Service manager failed to restart collector (init_type=$init_type)" >&2
                exit 1
                ;;
        esac
    fi

    if ! is_running; then
        echo "❌ collector process not found after restart" >&2
        exit 1
    fi

    # Schedule updater restart in a NEW process group so that
    # "launchctl stop / systemctl stop" of the updater won't kill this subprocess.
    local _restart_bin="$LOONGSUITE_PILOT_BIN"
    local _restart_log="$UPDATER_LOG_FILE"
    if command -v setsid &>/dev/null; then
        setsid bash -c 'sleep 10 && "$0" restart-updater' "$_restart_bin" >> "$_restart_log" 2>&1 &
    else
        perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- bash -c 'sleep 10 && "$0" restart-updater' "$_restart_bin" >> "$_restart_log" 2>&1 &
    fi
}

cmd_restart_updater() {
    local target_user
    target_user=$(whoami)
    local sys_unit="loongsuite-pilot-updater-${target_user}.service"
    local initd_script="/etc/init.d/loongsuite-pilot-updater-${target_user}"
    local init_type=""
    if [ -f "$INIT_TYPE_FILE" ]; then
        init_type=$(cat "$INIT_TYPE_FILE" 2>/dev/null | tr -d '[:space:]')
    fi

    # Stop updater via service manager
    case "$(uname -s)" in
        Darwin)
            launchctl stop "$UPDATER_LABEL" 2>/dev/null || true
            ;;
        Linux)
            case "$init_type" in
                systemd-user)
                    systemctl --user stop loongsuite-pilot-updater.service &>/dev/null || true
                    ;;
                systemd-system|systemd)
                    sudo systemctl stop "$sys_unit" &>/dev/null || true
                    ;;
                initd)
                    [ -f "$initd_script" ] && sudo "$initd_script" stop &>/dev/null || true
                    ;;
            esac
            ;;
    esac
    pkill -f "loongsuite-pilot/bin/updater-daemon" 2>/dev/null || true
    stop_pid_file "$UPDATER_PID_FILE"

    sleep 1

    ensure_dirs
    sync_bootstrap_scripts

    # Start updater via service manager
    local _restarted=false
    case "$(uname -s)" in
        Darwin)
            if launchctl list "$UPDATER_LABEL" &>/dev/null; then
                launchctl start "$UPDATER_LABEL" 2>/dev/null || true
                _restarted=true
            fi
            ;;
        Linux)
            case "$init_type" in
                systemd-user)
                    if systemctl --user is-enabled loongsuite-pilot-updater.service &>/dev/null; then
                        systemctl --user start loongsuite-pilot-updater.service &>/dev/null
                        echo "✅ updater restarted (systemd user-level)"
                        _restarted=true
                    fi
                    ;;
                systemd-system|systemd)
                    if [ -f "$SYSTEMD_SYSTEM_UNIT_DIR/$sys_unit" ] && sudo -n systemctl is-enabled "$sys_unit" &>/dev/null; then
                        sudo systemctl start "$sys_unit" &>/dev/null
                        echo "✅ updater restarted (systemd system-level)"
                        _restarted=true
                    fi
                    ;;
                initd)
                    if [ -f "$initd_script" ]; then
                        sudo "$initd_script" start &>/dev/null
                        echo "✅ updater restarted (init.d)"
                        _restarted=true
                    fi
                    ;;
            esac
            ;;
    esac
    # Verify the service manager actually started the updater process
    if [ "$_restarted" = true ]; then
        sleep 1
        if ! updater_process_exists; then
            echo "⚠️  service manager reported success but updater process not found"
            _restarted=false
        fi
    fi
    if [ "$_restarted" = false ]; then
        # Self-healing: try to register a proper service for degraded installs
        case "$init_type" in
            nohup|unknown|"")
                local _new_init
                _new_init=$(detect_init_system "false")
                if [ "$_new_init" != "none" ]; then
                    if autostart_install_updater_only "false" 2>>"$UPDATER_LOG_FILE"; then
                        echo "✅ updater self-healed: registered as $_new_init"
                        _restarted=true
                    fi
                fi
                if [ "$_restarted" = false ]; then
                    local entry="$BOOTSTRAP_DIR/updater-daemon.js"
                    if [ ! -f "$entry" ]; then
                        echo "❌ Updater bootstrap script missing"
                        return 1
                    fi
                    local node_bin
                    node_bin=$(resolve_node) || {
                        echo "❌ node runtime not found" >&2
                        return 1
                    }
                    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
                    nohup "$node_bin" "$entry" >> "$UPDATER_LOG_FILE" 2>&1 &
                    echo "$!" > "$UPDATER_PID_FILE"
                    echo "⚠️  updater restarted (nohup fallback, self-heal failed)"
                fi
                ;;
            *)
                echo "❌ Service manager failed to restart updater (init_type=$init_type)" >&2
                return 1
                ;;
        esac
    fi

    if ! updater_process_exists; then
        echo "❌ updater process not found after restart" >&2
        return 1
    fi
}

cmd_restart() {
    cmd_stop
    sleep 1
    cmd_start
}

cmd_status() {
    local ver_info=""
    local version_dir
    version_dir=$(resolve_current_version) || true
    if [ -n "$version_dir" ] && [ -f "$version_dir/VERSION" ]; then
        local v; v=$(grep '^version=' "$version_dir/VERSION" | cut -d= -f2)
        local c; c=$(grep '^git_commit=' "$version_dir/VERSION" | cut -d= -f2)
        ver_info=" v${v} (${c})"
    fi

    if is_running; then
        local pid
        pid=$(cat "$PID_FILE")
        echo "✅ loongsuite-pilot${ver_info} is running (PID $pid)"
    else
        echo "⚪ loongsuite-pilot${ver_info} is not running"
    fi
    if is_pid_file_running "$UPDATER_PID_FILE"; then
        echo "   updater: running (PID $(cat "$UPDATER_PID_FILE"))"
    else
        echo "   updater: stopped"
    fi
    local sampler_pid=""
    local dashboard_pid=""
    if is_pid_file_running "$MONITOR_PID_FILE"; then sampler_pid=$(cat "$MONITOR_PID_FILE"); fi
    if is_pid_file_running "$DASHBOARD_PID_FILE"; then dashboard_pid=$(cat "$DASHBOARD_PID_FILE"); fi
    if [ -n "$sampler_pid" ] && [ -n "$dashboard_pid" ]; then
        echo "   monitor: running (sampler PID $sampler_pid, dashboard PID $dashboard_pid)"
    elif [ -n "$sampler_pid" ] || [ -n "$dashboard_pid" ]; then
        echo "   monitor: partially running (sampler PID ${sampler_pid:-stopped}, dashboard PID ${dashboard_pid:-stopped})"
    else
        echo "   monitor: stopped"
    fi
    autostart_status
}

cmd_info() {
    local version_dir
    version_dir=$(resolve_current_version) || true
    if [ -n "$version_dir" ] && [ -f "$version_dir/VERSION" ]; then
        cat "$version_dir/VERSION"
    else
        echo "version=unknown"
    fi
    echo ""
    echo "data_dir=$DATA_DIR"
    echo "config=$CONFIG_FILE"
    echo "log=$LOG_FILE"
    echo "versions_dir=$VERSIONS_DIR"

    if [ -f "$NODE_PIN_FILE" ]; then
        local pinned_node
        pinned_node=$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$pinned_node" ] && [ -x "$pinned_node" ]; then
            echo "node_bin=$pinned_node"
            echo "node_version=$("$pinned_node" --version 2>/dev/null || echo 'unknown')"
        else
            echo "node_bin=$pinned_node (stale)"
            local resolved
            resolved=$(resolve_node 2>/dev/null) || true
            echo "node_version=$("${resolved:-node}" --version 2>/dev/null || echo 'unknown')"
        fi
    else
        echo "node_bin=not pinned"
        local resolved
        resolved=$(resolve_node 2>/dev/null) || true
        if [ -n "$resolved" ]; then
            echo "node_resolved=$resolved"
            echo "node_version=$("$resolved" --version 2>/dev/null || echo 'unknown')"
        fi
    fi

    echo ""
    if [ -f "$CONFIG_FILE" ]; then
        cat "$CONFIG_FILE"
    fi
}

cmd_worker() {
    ensure_dirs
    sync_bootstrap_scripts

    local node_bin
    node_bin=$(resolve_node) || {
        echo "❌ node runtime not found" >&2
        exit 1
    }

    local version_dir
    version_dir=$(resolve_current_version) || {
        echo "❌ No valid loongsuite-pilot version found" >&2
        exit 1
    }
    local entry="$version_dir/dist/index.js"

    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
    exec "$node_bin" "$entry" worker "$@"
}

cmd_token_usage() {
    ensure_dirs

    local repo_dir version_dir entry candidate node_bin
    repo_dir="$(dirname "$SCRIPT_DIR")"
    entry=""

    if [ -f "$repo_dir/package.json" ] && [ -d "$repo_dir/src" ]; then
        if [ -f "$repo_dir/dist/index.js" ]; then
            entry="$repo_dir/dist/index.js"
        else
            echo "❌ local dist/index.js not found; run 'npm run build' first"
            exit 1
        fi
    else
        version_dir=$(resolve_current_version 2>/dev/null) || true
        for candidate in \
            "${version_dir:-}/dist/index.js" \
            "$PACKAGE_DIR/dist/index.js"; do
            if [ -f "$candidate" ]; then
                entry="$candidate"
                break
            fi
        done
    fi

    if [ -z "$entry" ]; then
        echo "❌ loongsuite-pilot runtime entry not found"
        exit 1
    fi

    node_bin=$(resolve_node) || {
        echo "❌ node runtime not found" >&2
        exit 1
    }

    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
    exec "$node_bin" "$entry" token-usage "$@"
}

cmd_rollback() {
    if [ ! -f "$PREVIOUS_FILE" ]; then
        echo "❌ No previous version to roll back to"
        exit 1
    fi

    local prev_dir
    prev_dir=$(cat "$PREVIOUS_FILE" 2>/dev/null | tr -d '[:space:]')
    if [ -z "$prev_dir" ] || [ ! -d "$VERSIONS_DIR/$prev_dir" ]; then
        echo "❌ Previous version directory not found: $prev_dir"
        exit 1
    fi

    local curr_dir=""
    if [ -f "$CURRENT_FILE" ]; then
        curr_dir=$(cat "$CURRENT_FILE" 2>/dev/null | tr -d '[:space:]')
    fi

    echo "$prev_dir" > "$CURRENT_FILE.tmp"
    mv -f "$CURRENT_FILE.tmp" "$CURRENT_FILE"
    if [ -n "$curr_dir" ]; then
        echo "$curr_dir" > "$PREVIOUS_FILE.tmp"
        mv -f "$PREVIOUS_FILE.tmp" "$PREVIOUS_FILE"
    fi

    if ! sync_installed_scripts_from_version "$VERSIONS_DIR/$prev_dir"; then
        if [ -n "$curr_dir" ]; then
            echo "$curr_dir" > "$CURRENT_FILE.tmp"
            mv -f "$CURRENT_FILE.tmp" "$CURRENT_FILE"
            echo "$prev_dir" > "$PREVIOUS_FILE.tmp"
            mv -f "$PREVIOUS_FILE.tmp" "$PREVIOUS_FILE"
            sync_installed_scripts_from_version "$VERSIONS_DIR/$curr_dir" 2>/dev/null || true
        fi
        echo "❌ Failed to sync scripts for rollback target: $prev_dir"
        exit 1
    fi

    echo "✅ Rolled back to version: $prev_dir"
    echo "   Restarting service..."
    cmd_restart
}

# ---- Autostart management (internal) ----

_write_launchd_plist() {
    mkdir -p "$(dirname "$LAUNCHD_PLIST")"
    ensure_dirs
    cat > "$LAUNCHD_PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${LOONGSUITE_PILOT_BIN}</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AGENT_DATA_COLLECTION_CONFIG</key>
        <string>${CONFIG_FILE}</string>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLISTEOF
}

SYSTEMD_USER_UNIT_DIR="$HOME/.config/systemd/user"

_write_systemd_user_unit() {
    mkdir -p "$SYSTEMD_USER_UNIT_DIR"
    cat > "$SYSTEMD_USER_UNIT_DIR/loongsuite-pilot.service" << UNITEOF
[Unit]
Description=LoongSuite Pilot
After=default.target

[Service]
Type=simple
ExecStart=%h/.local/bin/loongsuite-pilot run
WorkingDirectory=%h/.loongsuite-pilot
Environment=AGENT_DATA_COLLECTION_CONFIG=%h/.loongsuite-pilot/config.json
Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=default.target
UNITEOF
}

_write_systemd_user_updater_unit() {
    mkdir -p "$SYSTEMD_USER_UNIT_DIR"
    cat > "$SYSTEMD_USER_UNIT_DIR/loongsuite-pilot-updater.service" << UNITEOF
[Unit]
Description=LoongSuite Pilot Auto-Updater
After=default.target

[Service]
Type=simple
ExecStart=%h/.local/bin/loongsuite-pilot run-updater
WorkingDirectory=%h/.loongsuite-pilot
Environment=AGENT_DATA_COLLECTION_CONFIG=%h/.loongsuite-pilot/config.json
KillMode=process
Restart=on-failure
RestartSec=60
LimitNOFILE=65536

[Install]
WantedBy=default.target
UNITEOF
}

_write_systemd_system_unit() {
    local target_user="$1"
    local target_home
    target_home=$(resolve_user_home "$target_user")
    local target_bin="$target_home/.local/bin/loongsuite-pilot"
    local target_config="$target_home/.loongsuite-pilot/config.json"
    local target_workdir="$target_home/.loongsuite-pilot"
    local unit_name="loongsuite-pilot-${target_user}.service"
    local unit_path="$SYSTEMD_SYSTEM_UNIT_DIR/$unit_name"

    sudo mkdir -p "$SYSTEMD_SYSTEM_UNIT_DIR"
    ensure_dirs
    sudo tee "$unit_path" > /dev/null << UNITEOF
[Unit]
Description=LoongSuite Pilot (${target_user})
After=network.target

[Service]
Type=simple
User=${target_user}
Group=$(id -gn "$target_user" 2>/dev/null || echo "$target_user")
ExecStart=${target_bin} run
WorkingDirectory=${target_workdir}
Environment=HOME=${target_home}
Environment=AGENT_DATA_COLLECTION_CONFIG=${target_config}
Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNITEOF
}

_write_launchd_updater_plist() {
    mkdir -p "$(dirname "$UPDATER_PLIST")"
    ensure_dirs
    cat > "$UPDATER_PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${UPDATER_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${LOONGSUITE_PILOT_BIN}</string>
        <string>run-updater</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${UPDATER_LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${UPDATER_LOG_FILE}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AGENT_DATA_COLLECTION_CONFIG</key>
        <string>${CONFIG_FILE}</string>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>AbandonProcessGroup</key>
    <true/>
</dict>
</plist>
PLISTEOF
}

_write_systemd_system_updater_unit() {
    local target_user="$1"
    local target_home
    target_home=$(resolve_user_home "$target_user")
    local target_bin="$target_home/.local/bin/loongsuite-pilot"
    local target_config="$target_home/.loongsuite-pilot/config.json"
    local target_workdir="$target_home/.loongsuite-pilot"
    local unit_name="loongsuite-pilot-updater-${target_user}.service"
    local unit_path="$SYSTEMD_SYSTEM_UNIT_DIR/$unit_name"

    sudo mkdir -p "$SYSTEMD_SYSTEM_UNIT_DIR"
    ensure_dirs
    sudo tee "$unit_path" > /dev/null << UNITEOF
[Unit]
Description=LoongSuite Pilot Auto-Updater (${target_user})
After=network.target

[Service]
Type=simple
User=${target_user}
Group=$(id -gn "$target_user" 2>/dev/null || echo "$target_user")
ExecStart=${target_bin} run-updater
WorkingDirectory=${target_workdir}
Environment=HOME=${target_home}
Environment=AGENT_DATA_COLLECTION_CONFIG=${target_config}
KillMode=process
Restart=on-failure
RestartSec=60
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNITEOF
}

_write_initd_script() {
    local target_user="$1"
    local target_home
    target_home=$(resolve_user_home "$target_user")
    local daemon_bin="$target_home/.local/bin/loongsuite-pilot"
    local daemon_name="loongsuite-pilot-${target_user}"
    local pid_file="$target_home/.loongsuite-pilot/loongsuite-pilot.pid"
    local log_file="$target_home/.loongsuite-pilot/logs/loongsuite-pilot-service.log"
    local config_file="$target_home/.loongsuite-pilot/config.json"
    local script_path="/etc/init.d/$daemon_name"
    local daemon_group
    daemon_group=$(id -gn "$target_user" 2>/dev/null || echo "$target_user")

    local tmp_script
    tmp_script=$(mktemp)

    cat > "$tmp_script" << 'INITEOF'
#!/bin/bash
### BEGIN INIT INFO
# Provides:          DAEMON_NAME_PLACEHOLDER
# Required-Start:    $local_fs $network
# Required-Stop:     $local_fs $network
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Description:       LoongSuite Pilot data collector (USER_PLACEHOLDER)
### END INIT INFO
# chkconfig: 2345 90 10

DAEMON_USER="USER_PLACEHOLDER"
DAEMON_GROUP="GROUP_PLACEHOLDER"
DAEMON_HOME="HOME_PLACEHOLDER"
DAEMON_BIN="BIN_PLACEHOLDER"
DAEMON_NAME="DAEMON_NAME_PLACEHOLDER"
PID_FILE="PID_PLACEHOLDER"
LOG_FILE="LOG_PLACEHOLDER"
CONFIG_FILE="CONFIG_PLACEHOLDER"

do_start() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$DAEMON_NAME is already running (PID $pid)"
            return 0
        fi
        rm -f "$PID_FILE"
    fi

    echo -n "Starting $DAEMON_NAME... "
    mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"

    if command -v start-stop-daemon &>/dev/null; then
        start-stop-daemon --start --chuid "$DAEMON_USER" \
            --background --make-pidfile --pidfile "$PID_FILE" \
            --exec "$DAEMON_BIN" -- run \
            >>"$LOG_FILE" 2>&1
        chown "$DAEMON_USER:$DAEMON_GROUP" "$LOG_FILE" "$PID_FILE"
    else
        su - "$DAEMON_USER" -c "
            export AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'
            nohup '$DAEMON_BIN' run >> '$LOG_FILE' 2>&1 &
            echo \$! > '$PID_FILE'
        "
    fi
    echo "done"
}

do_stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "$DAEMON_NAME is not running"
        return 0
    fi
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        echo "$DAEMON_NAME is not running"
        return 0
    fi

    echo -n "Stopping $DAEMON_NAME... "
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
    echo "done"
}

do_status() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$DAEMON_NAME is running (PID $pid)"
            return 0
        fi
    fi
    echo "$DAEMON_NAME is not running"
    return 1
}

case "$1" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart) do_stop; sleep 1; do_start ;;
    status)  do_status ;;
    *)       echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;
esac
INITEOF

    sed -i.bak \
        -e "s|USER_PLACEHOLDER|${target_user}|g" \
        -e "s|GROUP_PLACEHOLDER|${daemon_group}|g" \
        -e "s|HOME_PLACEHOLDER|${target_home}|g" \
        -e "s|BIN_PLACEHOLDER|${daemon_bin}|g" \
        -e "s|DAEMON_NAME_PLACEHOLDER|${daemon_name}|g" \
        -e "s|PID_PLACEHOLDER|${pid_file}|g" \
        -e "s|LOG_PLACEHOLDER|${log_file}|g" \
        -e "s|CONFIG_PLACEHOLDER|${config_file}|g" \
        "$tmp_script"
    rm -f "${tmp_script}.bak"

    sudo install -m 755 "$tmp_script" "$script_path"
    rm -f "$tmp_script"
}

_write_initd_updater_script() {
    local target_user="$1"
    local target_home
    target_home=$(resolve_user_home "$target_user")
    local daemon_bin="$target_home/.local/bin/loongsuite-pilot"
    local daemon_name="loongsuite-pilot-updater-${target_user}"
    local pid_file="$target_home/.loongsuite-pilot/loongsuite-pilot-updater.pid"
    local log_file="$target_home/.loongsuite-pilot/logs/loongsuite-pilot-updater.log"
    local config_file="$target_home/.loongsuite-pilot/config.json"
    local script_path="/etc/init.d/$daemon_name"
    local daemon_group
    daemon_group=$(id -gn "$target_user" 2>/dev/null || echo "$target_user")

    local tmp_script
    tmp_script=$(mktemp)

    cat > "$tmp_script" << 'INITEOF'
#!/bin/bash
### BEGIN INIT INFO
# Provides:          DAEMON_NAME_PLACEHOLDER
# Required-Start:    $local_fs $network
# Required-Stop:     $local_fs $network
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Description:       LoongSuite Pilot auto-updater (USER_PLACEHOLDER)
### END INIT INFO
# chkconfig: 2345 91 9

DAEMON_USER="USER_PLACEHOLDER"
DAEMON_GROUP="GROUP_PLACEHOLDER"
DAEMON_HOME="HOME_PLACEHOLDER"
DAEMON_BIN="BIN_PLACEHOLDER"
DAEMON_NAME="DAEMON_NAME_PLACEHOLDER"
PID_FILE="PID_PLACEHOLDER"
LOG_FILE="LOG_PLACEHOLDER"
CONFIG_FILE="CONFIG_PLACEHOLDER"

do_start() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$DAEMON_NAME is already running (PID $pid)"
            return 0
        fi
        rm -f "$PID_FILE"
    fi

    echo -n "Starting $DAEMON_NAME... "
    mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"

    if command -v start-stop-daemon &>/dev/null; then
        start-stop-daemon --start --chuid "$DAEMON_USER" \
            --background --make-pidfile --pidfile "$PID_FILE" \
            --exec "$DAEMON_BIN" -- run-updater \
            >>"$LOG_FILE" 2>&1
        chown "$DAEMON_USER:$DAEMON_GROUP" "$LOG_FILE" "$PID_FILE"
    else
        su - "$DAEMON_USER" -c "
            export AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'
            nohup '$DAEMON_BIN' run-updater >> '$LOG_FILE' 2>&1 &
            echo \$! > '$PID_FILE'
        "
    fi
    echo "done"
}

do_stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "$DAEMON_NAME is not running"
        return 0
    fi
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        echo "$DAEMON_NAME is not running"
        return 0
    fi

    echo -n "Stopping $DAEMON_NAME... "
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
    echo "done"
}

do_status() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$DAEMON_NAME is running (PID $pid)"
            return 0
        fi
    fi
    echo "$DAEMON_NAME is not running"
    return 1
}

case "$1" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart) do_stop; sleep 1; do_start ;;
    status)  do_status ;;
    *)       echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;
esac
INITEOF

    sed -i.bak \
        -e "s|USER_PLACEHOLDER|${target_user}|g" \
        -e "s|GROUP_PLACEHOLDER|${daemon_group}|g" \
        -e "s|HOME_PLACEHOLDER|${target_home}|g" \
        -e "s|BIN_PLACEHOLDER|${daemon_bin}|g" \
        -e "s|DAEMON_NAME_PLACEHOLDER|${daemon_name}|g" \
        -e "s|PID_PLACEHOLDER|${pid_file}|g" \
        -e "s|LOG_PLACEHOLDER|${log_file}|g" \
        -e "s|CONFIG_PLACEHOLDER|${config_file}|g" \
        "$tmp_script"
    rm -f "${tmp_script}.bak"

    sudo install -m 755 "$tmp_script" "$script_path"
    rm -f "$tmp_script"
}

_register_initd_boot() {
    local name="$1"
    if command -v chkconfig &>/dev/null; then
        sudo chkconfig --add "$name" &>/dev/null || true
    elif command -v update-rc.d &>/dev/null; then
        sudo update-rc.d "$name" defaults &>/dev/null || true
    else
        echo "⚠️  Neither chkconfig nor update-rc.d found, boot registration skipped for $name"
    fi
}

_unregister_initd_boot() {
    local name="$1"
    if command -v chkconfig &>/dev/null; then
        sudo chkconfig --del "$name" &>/dev/null || true
    elif command -v update-rc.d &>/dev/null; then
        sudo update-rc.d "$name" remove &>/dev/null || true
    fi
}

autostart_install_collector_only() {
    local interactive="${1:-true}"

    local init_system
    init_system=$(detect_init_system "$interactive")
    local target_user
    target_user=$(whoami)

    case "$init_system" in
        launchd)
            launchctl unload -w "$LAUNCHD_PLIST" 2>/dev/null || true
            _write_launchd_plist
            launchctl load -w "$LAUNCHD_PLIST"
            echo "launchd" > "$INIT_TYPE_FILE"
            ;;
        systemd-user)
            _write_systemd_user_unit
            systemctl --user daemon-reload &>/dev/null
            systemctl --user enable --now loongsuite-pilot.service &>/dev/null
            enable_linger || true
            echo "systemd-user" > "$INIT_TYPE_FILE"
            ;;
        systemd-system)
            _write_systemd_system_unit "$target_user"
            sudo systemctl daemon-reload &>/dev/null
            sudo systemctl enable --now "loongsuite-pilot-${target_user}.service" &>/dev/null
            echo "systemd-system" > "$INIT_TYPE_FILE"
            ;;
        initd)
            _write_initd_script "$target_user"
            _register_initd_boot "loongsuite-pilot-${target_user}"
            sudo "/etc/init.d/loongsuite-pilot-${target_user}" start &>/dev/null || true
            echo "initd" > "$INIT_TYPE_FILE"
            ;;
        *)
            return 1
            ;;
    esac
}

autostart_install_updater_only() {
    local interactive="${1:-true}"

    local init_system
    init_system=$(detect_init_system "$interactive")
    local target_user
    target_user=$(whoami)

    case "$init_system" in
        launchd)
            launchctl unload -w "$UPDATER_PLIST" 2>/dev/null || true
            _write_launchd_updater_plist
            launchctl load -w "$UPDATER_PLIST"
            echo "launchd" > "$INIT_TYPE_FILE"
            ;;
        systemd-user)
            _write_systemd_user_updater_unit
            systemctl --user daemon-reload &>/dev/null
            systemctl --user enable --now loongsuite-pilot-updater.service &>/dev/null
            enable_linger || true
            echo "systemd-user" > "$INIT_TYPE_FILE"
            ;;
        systemd-system)
            _write_systemd_system_updater_unit "$target_user"
            sudo systemctl daemon-reload &>/dev/null
            sudo systemctl enable --now "loongsuite-pilot-updater-${target_user}.service" &>/dev/null
            echo "systemd-system" > "$INIT_TYPE_FILE"
            ;;
        initd)
            _write_initd_updater_script "$target_user"
            _register_initd_boot "loongsuite-pilot-updater-${target_user}"
            sudo "/etc/init.d/loongsuite-pilot-updater-${target_user}" start &>/dev/null || true
            echo "initd" > "$INIT_TYPE_FILE"
            ;;
        *)
            return 1
            ;;
    esac
}

autostart_install() {
    local interactive="${1:-true}"

    local init_system
    init_system=$(detect_init_system "$interactive")
    local target_user
    target_user=$(whoami)

    case "$init_system" in
        launchd)
            launchctl unload -w "$LAUNCHD_PLIST" 2>/dev/null || true
            _write_launchd_plist
            launchctl load -w "$LAUNCHD_PLIST"
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                launchctl unload -w "$UPDATER_PLIST" 2>/dev/null || true
                _write_launchd_updater_plist
                launchctl load -w "$UPDATER_PLIST"
            fi
            echo "launchd" > "$INIT_TYPE_FILE"
            ;;
        systemd-user)
            _write_systemd_user_unit
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                _write_systemd_user_updater_unit
            fi
            systemctl --user daemon-reload &>/dev/null
            systemctl --user enable --now loongsuite-pilot.service &>/dev/null
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                systemctl --user enable --now loongsuite-pilot-updater.service &>/dev/null
            fi
            enable_linger || true
            echo "systemd-user" > "$INIT_TYPE_FILE"
            ;;
        systemd-system)
            _write_systemd_system_unit "$target_user"
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                _write_systemd_system_updater_unit "$target_user"
            fi
            sudo systemctl daemon-reload &>/dev/null
            sudo systemctl enable --now "loongsuite-pilot-${target_user}.service" &>/dev/null
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                sudo systemctl enable --now "loongsuite-pilot-updater-${target_user}.service" &>/dev/null
            fi
            echo "systemd-system" > "$INIT_TYPE_FILE"
            ;;
        initd)
            _write_initd_script "$target_user"
            _register_initd_boot "loongsuite-pilot-${target_user}"
            sudo "/etc/init.d/loongsuite-pilot-${target_user}" start &>/dev/null || true
            if [ -f "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
                _write_initd_updater_script "$target_user"
                _register_initd_boot "loongsuite-pilot-updater-${target_user}"
                sudo "/etc/init.d/loongsuite-pilot-updater-${target_user}" start &>/dev/null || true
            fi
            echo "initd" > "$INIT_TYPE_FILE"
            ;;
        *)
            return 1
            ;;
    esac
}

autostart_remove() {
    local init_system
    init_system=$(detect_init_system "false")
    local target_user
    target_user=$(whoami)

    case "$init_system" in
        launchd)
            launchctl unload -w "$UPDATER_PLIST" 2>/dev/null || true
            rm -f "$UPDATER_PLIST"
            launchctl unload -w "$LAUNCHD_PLIST" 2>/dev/null || true
            rm -f "$LAUNCHD_PLIST"
            ;;
        systemd-user)
            systemctl --user disable --now loongsuite-pilot-updater.service &>/dev/null || true
            systemctl --user disable --now loongsuite-pilot.service &>/dev/null || true
            rm -f "$SYSTEMD_USER_UNIT_DIR/loongsuite-pilot.service"
            rm -f "$SYSTEMD_USER_UNIT_DIR/loongsuite-pilot-updater.service"
            systemctl --user daemon-reload &>/dev/null || true
            ;;
        systemd-system|systemd)
            sudo systemctl disable --now "loongsuite-pilot-updater-${target_user}.service" &>/dev/null || true
            sudo systemctl disable --now "loongsuite-pilot-${target_user}.service" &>/dev/null || true
            sudo rm -f "$SYSTEMD_SYSTEM_UNIT_DIR/loongsuite-pilot-${target_user}.service"
            sudo rm -f "$SYSTEMD_SYSTEM_UNIT_DIR/loongsuite-pilot-updater-${target_user}.service"
            sudo systemctl daemon-reload &>/dev/null || true
            ;;
        initd)
            sudo "/etc/init.d/loongsuite-pilot-${target_user}" stop &>/dev/null || true
            sudo "/etc/init.d/loongsuite-pilot-updater-${target_user}" stop &>/dev/null || true
            _unregister_initd_boot "loongsuite-pilot-${target_user}"
            _unregister_initd_boot "loongsuite-pilot-updater-${target_user}"
            sudo rm -f "/etc/init.d/loongsuite-pilot-${target_user}"
            sudo rm -f "/etc/init.d/loongsuite-pilot-updater-${target_user}"
            ;;
        *)
            ;;
    esac
    rm -f "$INIT_TYPE_FILE"
}

autostart_status() {
    local init_system
    init_system=$(detect_init_system)
    local target_user
    target_user=$(whoami)

    case "$init_system" in
        launchd)
            if [ -f "$LAUNCHD_PLIST" ] && launchctl list "$SERVICE_LABEL" &>/dev/null; then
                echo "   autostart: enabled (launchd)"
            else
                echo "   autostart: disabled"
            fi
            ;;
        systemd-user)
            if systemctl --user is-enabled loongsuite-pilot.service &>/dev/null; then
                local linger_status=""
                if [ -f "/var/lib/systemd/linger/$target_user" ]; then
                    linger_status=", linger active"
                fi
                echo "   autostart: enabled (systemd user-level${linger_status})"
            else
                echo "   autostart: disabled"
            fi
            ;;
        systemd-system|systemd)
            local unit_name="loongsuite-pilot-${target_user}.service"
            if [ -f "$SYSTEMD_SYSTEM_UNIT_DIR/$unit_name" ] && sudo -n systemctl is-enabled "$unit_name" &>/dev/null; then
                echo "   autostart: enabled (systemd system-level)"
            else
                echo "   autostart: disabled"
            fi
            ;;
        initd)
            if [ -f "/etc/init.d/loongsuite-pilot-${target_user}" ]; then
                echo "   autostart: enabled (init.d)"
            else
                echo "   autostart: disabled"
            fi
            ;;
        none)
            echo "   autostart: not available"
            ;;
        *)
            echo "   autostart: not available"
            ;;
    esac
}

# Manage ~/.loongsuite-pilot/span-attributes.json — user-defined attributes
# injected into trace spans (not the event log). The collector re-reads the
# file per turn, so changes take effect without a restart.
_span_attr_run() {
    local node_bin
    node_bin=$(resolve_node) || { echo "[span-attr] node runtime not found" >&2; exit 1; }
    "$node_bin" -e '
const fs = require("fs");
const file = process.argv[1], op = process.argv[2], key = process.argv[3], value = process.argv[4];
const RESERVED = ["gen_ai.","git.","workspace.","event.","trace_","user.","cost_","agent.","time_unix_nano","observed_time_unix_nano"];
const isReserved = k => RESERVED.some(p => k === p || k.indexOf(p) === 0);
function read() { try { const o = JSON.parse(fs.readFileSync(file, "utf-8")); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; } catch { return {}; } }
function write(o) { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n"); fs.renameSync(tmp, file); }
if (op === "set") {
  if (!key || value === undefined) { console.error("usage: span-attr set <key> <value>"); process.exit(1); }
  if (isReserved(key)) { console.error("refused: \"" + key + "\" uses a reserved prefix (gen_ai./git./workspace./event./trace_/user./cost_/agent./...)"); process.exit(1); }
  const o = read(); o[key] = String(value); write(o); console.log("set " + key + "=" + o[key]);
} else if (op === "unset") {
  if (!key) { console.error("usage: span-attr unset <key>"); process.exit(1); }
  const o = read(); if (Object.prototype.hasOwnProperty.call(o, key)) { delete o[key]; write(o); console.log("unset " + key); } else { console.log("(no such key: " + key + ")"); }
} else if (op === "list") {
  const o = read(); const ks = Object.keys(o);
  if (ks.length === 0) { console.log("(no custom span attributes)"); } else { for (const k of ks) console.log(k + "=" + o[k]); }
}
' "$SPAN_ATTR_FILE" "$@"
}

cmd_span_attr() {
    local sub="${1:-}"
    case "$sub" in
        set)   shift; _span_attr_run set "$@" ;;
        unset) shift; _span_attr_run unset "$@" ;;
        list)  _span_attr_run list ;;
        clear)
            rm -f "$SPAN_ATTR_FILE"
            echo "cleared custom span attributes ($SPAN_ATTR_FILE)"
            ;;
        ""|help|-h|--help)
            echo "Usage: loongsuite-pilot span-attr <set|unset|list|clear>"
            echo ""
            echo "  set <key> <value>   Set a custom trace span attribute"
            echo "  unset <key>         Remove a custom attribute"
            echo "  list                Show current custom attributes"
            echo "  clear               Remove all custom attributes"
            echo ""
            echo "Attributes are injected into trace spans only (not the event log)."
            echo "Reserved-prefix keys (gen_ai./git./workspace./event./trace_/user./cost_/agent./...) are rejected."
            echo "Changes take effect on the next turn — no restart needed." ;;
        *)
            echo "Unknown span-attr command: $sub" >&2
            echo "Usage: loongsuite-pilot span-attr <set|unset|list|clear>" >&2
            exit 1 ;;
    esac
}

cmd_help() {
    echo "Usage: loongsuite-pilot <command> [options]"
    echo ""
    echo "Commands:"
    echo "  start           Start the collector service"
    echo "  stop            Stop the collector service"
    echo "  restart         Restart the collector service"
    echo "  status          Show service status (default)"
    echo "  info            Show version and config info"
    echo "  token-usage     Show token usage TUI"
    echo "  span-attr ...   Manage custom trace span attributes (set/unset/list/clear)"
    echo "  monitor start   Start process resource monitor"
    echo "  monitor stop    Stop process resource monitor"
    echo "  worker ...      Manage local remote-controlled workers"
    echo "  rollback        Roll back to the previous version"
    echo "  help            Show this help message"
}

cmd_monitor() {
    case "${1:-}" in
        start) cmd_monitor_start ;;
        stop)  cmd_monitor_stop ;;
        *)
            echo "Unknown monitor command: ${1:-}"
            echo "Usage: loongsuite-pilot monitor <start|stop>"
            exit 1 ;;
    esac
}

# ---- Dispatch ----

case "${1:-status}" in
    start)       shift; cmd_start "$@" ;;
    stop)        cmd_stop ;;
    restart)     cmd_restart ;;
    status)      cmd_status ;;
    info)        cmd_info ;;
    token-usage) shift; cmd_token_usage "$@" ;;
    tokens)      shift; cmd_token_usage "$@" ;;
    span-attr)   shift; cmd_span_attr "$@" ;;
    monitor)             cmd_monitor "${2:-}" ;;
    worker)              shift; cmd_worker "$@" ;;
    rollback)            cmd_rollback ;;
    restart-collector)   cmd_restart_collector ;;
    restart-updater)     cmd_restart_updater ;;
    run)                 cmd_run ;;
    run-updater)         cmd_run_updater ;;
    help|--help|-h) cmd_help ;;
    *)
        echo "Unknown command: $1"
        cmd_help
        exit 1 ;;
esac
