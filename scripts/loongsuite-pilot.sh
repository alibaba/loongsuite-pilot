#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
CACHE_DIR="$HOME/.loongsuite-pilot"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS_DIR="$CACHE_DIR/versions"
CURRENT_FILE="$CACHE_DIR/current"
PREVIOUS_FILE="$CACHE_DIR/previous"
BOOTSTRAP_DIR="$CACHE_DIR/bin"
PACKAGE_DIR="$CACHE_DIR/package"
PID_FILE="$DATA_DIR/loongsuite-pilot.pid"
LOG_DIR="$DATA_DIR/logs"
LOG_FILE="$LOG_DIR/loongsuite-pilot-service.log"
UPDATER_LOG_FILE="$LOG_DIR/loongsuite-pilot-updater.log"
MONITOR_LOG_FILE="$LOG_DIR/loongsuite-pilot-monitor-process.log"
DASHBOARD_LOG_FILE="$LOG_DIR/loongsuite-pilot-dashboard.log"
CONFIG_FILE="$DATA_DIR/config.json"
MONITOR_PID_FILE="$DATA_DIR/loongsuite-pilot-monitor.pid"
DASHBOARD_PID_FILE="$DATA_DIR/loongsuite-pilot-dashboard.pid"
MONITOR_DATA_DIR="$LOG_DIR/process-monitor"

SERVICE_LABEL="com.loongsuite-pilot"
UPDATER_LABEL="com.loongsuite-pilot.updater"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
UPDATER_PLIST="$HOME/Library/LaunchAgents/${UPDATER_LABEL}.plist"
SYSTEMD_UNIT="loongsuite-pilot.service"
UPDATER_UNIT="loongsuite-pilot-updater.service"
SYSTEMD_UNIT_DIR="$HOME/.config/systemd/user"
SYSTEMD_UNIT_PATH="$SYSTEMD_UNIT_DIR/$SYSTEMD_UNIT"
UPDATER_UNIT_PATH="$SYSTEMD_UNIT_DIR/$UPDATER_UNIT"
LOONGSUITE_PILOT_BIN="$HOME/.local/bin/loongsuite-pilot"

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

resolve_node() {
    if command -v node >/dev/null 2>&1; then
        command -v node
        return 0
    fi
    for candidate in \
        "$HOME/.nvm/versions/node"/*/bin/node \
        /usr/local/bin/node \
        /opt/homebrew/bin/node \
        "$HOME/.local/bin/node" \
        "$HOME/.volta/bin/node" \
        "$HOME/.fnm/aliases/default/bin/node"; do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

detect_init_system() {
    case "$(uname -s)" in
        Darwin) echo "launchd" ;;
        Linux)
            if command -v systemctl &>/dev/null && systemctl --user status &>/dev/null 2>&1; then
                echo "systemd"
            else
                echo "none"
            fi
            ;;
        *) echo "none" ;;
    esac
}

is_managed_by_launchd() {
    [ -f "$LAUNCHD_PLIST" ] && launchctl list "$SERVICE_LABEL" &>/dev/null
}

is_managed_by_systemd() {
    [ -f "$SYSTEMD_UNIT_PATH" ] && systemctl --user is-enabled "$SYSTEMD_UNIT" &>/dev/null
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
        echo "❌ Bootstrap script missing" >&2
        exit 1
    fi

    local node_bin
    node_bin=$(resolve_node) || {
        echo "❌ node runtime not found" >&2
        exit 1
    }

    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
    exec "$node_bin" "$BOOTSTRAP_DIR/updater-daemon.js"
}

# ---- User-facing commands ----

cmd_start() {
    if is_running; then
        echo "✅ loongsuite-pilot is already running (PID $(cat "$PID_FILE"))"
        return 0
    fi

    ensure_dirs
    sync_bootstrap_scripts

    # Try launchd/systemd first (RunAtLoad starts the process automatically)
    if autostart_install 2>/dev/null; then
        sleep 2
        if is_managed_by_launchd || is_managed_by_systemd; then
            echo "✅ loongsuite-pilot started ($(detect_init_system))"
            return 0
        fi
    fi

    # Fallback to nohup
    local entry="$BOOTSTRAP_DIR/collector-daemon.js"
    if [ ! -f "$entry" ]; then
        echo "❌ Bootstrap script missing"
        exit 1
    fi

    export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
    nohup node "$entry" >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    echo "✅ loongsuite-pilot started (PID $pid)"
}

cmd_stop() {
    cmd_monitor_stop >/dev/null 2>&1 || true
    autostart_remove 2>/dev/null || true

    # Stop launchd/systemd managed services
    launchctl stop "$SERVICE_LABEL" 2>/dev/null || true
    launchctl stop "$UPDATER_LABEL" 2>/dev/null || true
    systemctl --user stop "$SYSTEMD_UNIT" 2>/dev/null || true
    systemctl --user stop "$UPDATER_UNIT" 2>/dev/null || true

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
    # Stop collector only (leave updater running)
    launchctl stop "$SERVICE_LABEL" 2>/dev/null || true
    systemctl --user stop "$SYSTEMD_UNIT" 2>/dev/null || true
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

    # Start collector (launchd KeepAlive will auto-restart, or start via nohup)
    ensure_dirs
    sync_bootstrap_scripts

    if launchctl list "$SERVICE_LABEL" &>/dev/null; then
        launchctl start "$SERVICE_LABEL" 2>/dev/null || true
        echo "✅ collector restarted (launchd)"
    elif [ -f "$SYSTEMD_UNIT_PATH" ] && systemctl --user is-enabled "$SYSTEMD_UNIT" &>/dev/null; then
        systemctl --user start "$SYSTEMD_UNIT"
        echo "✅ collector restarted (systemd)"
    else
        local entry="$BOOTSTRAP_DIR/collector-daemon.js"
        if [ ! -f "$entry" ]; then
            echo "❌ Bootstrap script missing"
            exit 1
        fi
        export AGENT_DATA_COLLECTION_CONFIG="$CONFIG_FILE"
        nohup node "$entry" >> "$LOG_FILE" 2>&1 &
        echo "$!" > "$PID_FILE"
        echo "✅ collector restarted (PID $!)"
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
    echo ""
    if [ -f "$CONFIG_FILE" ]; then
        cat "$CONFIG_FILE"
    fi
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

_write_systemd_unit() {
    mkdir -p "$SYSTEMD_UNIT_DIR"
    ensure_dirs
    cat > "$SYSTEMD_UNIT_PATH" << UNITEOF
[Unit]
Description=LoongSuite Pilot
After=default.target

[Service]
Type=simple
ExecStart=${LOONGSUITE_PILOT_BIN} run
Restart=on-failure
RestartSec=10
Environment=AGENT_DATA_COLLECTION_CONFIG=${CONFIG_FILE}

[Install]
WantedBy=default.target
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
</dict>
</plist>
PLISTEOF
}

_write_systemd_updater_unit() {
    mkdir -p "$SYSTEMD_UNIT_DIR"
    ensure_dirs
    cat > "$UPDATER_UNIT_PATH" << UNITEOF
[Unit]
Description=LoongSuite Pilot Auto-Updater
After=default.target

[Service]
Type=simple
ExecStart=${LOONGSUITE_PILOT_BIN} run-updater
Restart=on-failure
RestartSec=60
Environment=AGENT_DATA_COLLECTION_CONFIG=${CONFIG_FILE}

[Install]
WantedBy=default.target
UNITEOF
}

autostart_install() {
    local init_system
    init_system=$(detect_init_system)

    case "$init_system" in
        launchd)
            launchctl unload -w "$LAUNCHD_PLIST" 2>/dev/null || true
            launchctl unload -w "$UPDATER_PLIST" 2>/dev/null || true
            _write_launchd_plist
            _write_launchd_updater_plist
            launchctl load -w "$LAUNCHD_PLIST"
            launchctl load -w "$UPDATER_PLIST"
            ;;
        systemd)
            _write_systemd_unit
            _write_systemd_updater_unit
            systemctl --user daemon-reload
            systemctl --user enable --now "$SYSTEMD_UNIT"
            systemctl --user enable --now "$UPDATER_UNIT"
            if command -v loginctl &>/dev/null; then
                loginctl enable-linger "$(whoami)" 2>/dev/null || true
            fi
            ;;
        *)
            return 1
            ;;
    esac
}

autostart_remove() {
    local init_system
    init_system=$(detect_init_system)

    case "$init_system" in
        launchd)
            launchctl unload -w "$UPDATER_PLIST" 2>/dev/null || true
            rm -f "$UPDATER_PLIST"
            launchctl unload -w "$LAUNCHD_PLIST" 2>/dev/null || true
            rm -f "$LAUNCHD_PLIST"
            ;;
        systemd)
            systemctl --user disable --now "$UPDATER_UNIT" 2>/dev/null || true
            rm -f "$UPDATER_UNIT_PATH"
            systemctl --user disable --now "$SYSTEMD_UNIT" 2>/dev/null || true
            rm -f "$SYSTEMD_UNIT_PATH"
            systemctl --user daemon-reload 2>/dev/null || true
            ;;
    esac
}

autostart_status() {
    local init_system
    init_system=$(detect_init_system)

    case "$init_system" in
        launchd)
            if [ -f "$LAUNCHD_PLIST" ] && launchctl list "$SERVICE_LABEL" &>/dev/null; then
                echo "   autostart: enabled (launchd)"
            else
                echo "   autostart: disabled"
            fi
            ;;
        systemd)
            if [ -f "$SYSTEMD_UNIT_PATH" ] && systemctl --user is-enabled "$SYSTEMD_UNIT" &>/dev/null; then
                echo "   autostart: enabled (systemd)"
            else
                echo "   autostart: disabled"
            fi
            ;;
        *)
            echo "   autostart: not available"
            ;;
    esac
}

cmd_help() {
    echo "Usage: loongsuite-pilot <command>"
    echo ""
    echo "Commands:"
    echo "  start       Start the collector service"
    echo "  stop        Stop the collector service"
    echo "  restart     Restart the collector service"
    echo "  status      Show service status (default)"
    echo "  info        Show version and config info"
    echo "  monitor-start     Start process resource monitor"
    echo "  monitor-stop      Stop process resource monitor"
    echo "  rollback    Roll back to the previous version"
    echo "  help        Show this help message"
}

# ---- Dispatch ----

case "${1:-status}" in
    start)       cmd_start ;;
    stop)        cmd_stop ;;
    restart)     cmd_restart ;;
    status)      cmd_status ;;
    info)        cmd_info ;;
    monitor-start)       cmd_monitor_start ;;
    monitor-stop)        cmd_monitor_stop ;;
    rollback)            cmd_rollback ;;
    restart-collector)   cmd_restart_collector ;;
    run)                 cmd_run ;;
    run-updater)         cmd_run_updater ;;
    help|--help|-h) cmd_help ;;
    *)
        echo "Unknown command: $1"
        cmd_help
        exit 1 ;;
esac
