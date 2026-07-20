#!/bin/bash
# test-detect-init-runner.sh — Runs inside Docker container
# Called by test-detect-init-system.sh

set -e

PASS=0
FAIL=0

# --- Inline the functions under test ---
DATA_DIR_BASE="/tmp/pilot-test"

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
    local INIT_TYPE_FILE="$DATA_DIR/init-type"

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

export -f has_sudo_interactive has_sudo_noninteractive _detect_system_level_init detect_init_system

check() {
    local num="$1" desc="$2" expected="$3" actual="$4"
    actual=$(echo "$actual" | tr -d '[:space:]')
    if [ "$actual" = "$expected" ]; then
        echo "  ✅ Scenario $num: $desc → $actual"
        PASS=$((PASS + 1))
    else
        echo "  ❌ Scenario $num: $desc → $actual (expected: $expected)"
        FAIL=$((FAIL + 1))
    fi
}

# ========== Setup ==========
mkdir -p /run/systemd/system
mkdir -p /etc/init.d

# ========== Scenario 1: systemd-user (mocked) ==========
# Mock systemctl --user show-environment to succeed
cat > /usr/local/bin/systemctl <<'MOCK'
#!/bin/bash
if [[ "$1" == "--user" && "$2" == "show-environment" ]]; then exit 0; fi
exec /usr/bin/systemctl "$@"
MOCK
chmod +x /usr/local/bin/systemctl

export DATA_DIR="/home/testuser/.loongsuite-pilot"
mkdir -p "$DATA_DIR"
chown testuser:testuser "$DATA_DIR"
result=$(su -s /bin/bash testuser -c 'export DATA_DIR=/home/testuser/.loongsuite-pilot; eval "$(declare -f has_sudo_interactive has_sudo_noninteractive _detect_system_level_init detect_init_system)"; detect_init_system true' 2>/dev/null)
check 1 "systemd-user (mocked systemctl --user)" "systemd-user" "$result"

# Remove mock
rm -f /usr/local/bin/systemctl

# ========== Scenario 2: No systemd-user, sudo + systemd-system ==========
result=$(su -s /bin/bash testuser -c 'export DATA_DIR=/home/testuser/.loongsuite-pilot; eval "$(declare -f has_sudo_interactive has_sudo_noninteractive _detect_system_level_init detect_init_system)"; detect_init_system true' 2>/dev/null)
check 2 "No systemd-user, sudo + systemd-system" "systemd-system" "$result"

# ========== Scenario 3: No systemd, only init.d ==========
mv /usr/bin/systemctl /usr/bin/systemctl.bak 2>/dev/null || true
result=$(su -s /bin/bash testuser -c 'export DATA_DIR=/home/testuser/.loongsuite-pilot; eval "$(declare -f has_sudo_interactive has_sudo_noninteractive _detect_system_level_init detect_init_system)"; detect_init_system true' 2>/dev/null)
check 3 "No systemd, only init.d" "initd" "$result"
mv /usr/bin/systemctl.bak /usr/bin/systemctl 2>/dev/null || true

# ========== Scenario 4: Root + systemd ==========
export DATA_DIR="/root/.loongsuite-pilot"
mkdir -p "$DATA_DIR"
result=$(detect_init_system true)
check 4 "Root + systemd-system" "systemd-system" "$result"

# ========== Scenario 5: Root + no systemd, only init.d ==========
mv /usr/bin/systemctl /usr/bin/systemctl.bak 2>/dev/null || true
rm -rf /run/systemd/system
result=$(detect_init_system true)
check 5 "Root + no systemd, only init.d" "initd" "$result"
mv /usr/bin/systemctl.bak /usr/bin/systemctl 2>/dev/null || true
mkdir -p /run/systemd/system

# ========== Scenario 6: No init system, no sudo ==========
mv /usr/bin/systemctl /usr/bin/systemctl.bak 2>/dev/null || true
rm -rf /run/systemd/system /etc/init.d
export DATA_DIR="/home/nopwduser/.loongsuite-pilot"
mkdir -p "$DATA_DIR"
chown nopwduser:nopwduser "$DATA_DIR"
result=$(su -s /bin/bash nopwduser -c 'export DATA_DIR=/home/nopwduser/.loongsuite-pilot; eval "$(declare -f has_sudo_interactive has_sudo_noninteractive _detect_system_level_init detect_init_system)"; detect_init_system true' 2>/dev/null)
check 6 "No init system + sudo needs password" "none" "$result"
mv /usr/bin/systemctl.bak /usr/bin/systemctl 2>/dev/null || true
mkdir -p /run/systemd/system /etc/init.d

# ========== Scenario 7: interactive=false + sudo needs password ==========
result=$(su -s /bin/bash nopwduser -c 'export DATA_DIR=/home/nopwduser/.loongsuite-pilot; eval "$(declare -f has_sudo_interactive has_sudo_noninteractive _detect_system_level_init detect_init_system)"; detect_init_system false' 2>/dev/null)
check 7 "interactive=false, sudo needs password" "none" "$result"

# ========== Scenario 8: Cached init-type=nohup → ignored ==========
export DATA_DIR="/home/testuser/.loongsuite-pilot"
echo "nohup" > "$DATA_DIR/init-type"
chown testuser:testuser "$DATA_DIR/init-type"
result=$(su -s /bin/bash testuser -c 'export DATA_DIR=/home/testuser/.loongsuite-pilot; eval "$(declare -f has_sudo_interactive has_sudo_noninteractive _detect_system_level_init detect_init_system)"; detect_init_system true' 2>/dev/null)
check 8 "Cached nohup ignored → re-detects systemd-system" "systemd-system" "$result"
rm -f "$DATA_DIR/init-type"

# ========== Scenario 9: Valid cached init-type=initd → honored ==========
echo "initd" > "$DATA_DIR/init-type"
chown testuser:testuser "$DATA_DIR/init-type"
result=$(su -s /bin/bash testuser -c 'export DATA_DIR=/home/testuser/.loongsuite-pilot; eval "$(declare -f has_sudo_interactive has_sudo_noninteractive _detect_system_level_init detect_init_system)"; detect_init_system true' 2>/dev/null)
check 9 "Valid cached init-type=initd honored" "initd" "$result"
rm -f "$DATA_DIR/init-type"

# ========== Scenario 10: interactive=false + NOPASSWD sudo ==========
result=$(su -s /bin/bash testuser -c 'export DATA_DIR=/home/testuser/.loongsuite-pilot; eval "$(declare -f has_sudo_interactive has_sudo_noninteractive _detect_system_level_init detect_init_system)"; detect_init_system false' 2>/dev/null)
check 10 "interactive=false + NOPASSWD sudo → systemd-system" "systemd-system" "$result"

# ========== Results ==========
echo ""
echo "============================================"
echo " Results: $PASS passed, $FAIL failed"
echo "============================================"

[ "$FAIL" -eq 0 ] || exit 1
