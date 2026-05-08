## Context

The `loongsuite-pilot.sh` service management script is the single entry point for starting, stopping, and managing the loongsuite-pilot service. It already handles macOS launchd and Linux systemd user-level services. The installer (`loongsuite-pilot-installer.sh`) orchestrates first-time install and calls `loongsuite-pilot start`, which delegates to `autostart_install()`.

Key constraint: multiple OS users on the same Linux host may each have their own loongsuite-pilot installation. Service files must be namespaced per user to prevent conflicts.

**Key design shift**: The installer runs as the **current user** (including root). File installation happens under the user's `$HOME` with correct ownership by default. For non-root users, systemd/init.d privileged operations are elevated via `sudo`. Root users already have privileges so `sudo` is a no-op. This eliminates the need for `--run-as-user` parameter and `fix_ownership()`.

All changes are in shell scripts — no TypeScript/Node.js changes required (logging changes are handled separately).

## Goals / Non-Goals

**Goals:**

- Replace existing systemd user-level support with system-level systemd service registration, using `sudo` for privileged operations (not requiring the entire installer to run as root).
- Add `sudo -v` pre-check to validate sudo access before attempting service registration. Fall back to nohup with a clear warning if sudo is unavailable.
- Record current user identity via `$(whoami)` (including root) for per-user naming.
- Support init.d/SysVinit service registration as fallback when systemd is unavailable, also via `sudo`.
- Prioritize systemd over init.d when both are available.
- Clean up all registered services on uninstall, including system-level units and init.d scripts.

**Non-Goals:**

- OpenRC support (Alpine) — could be added later, init.d scripts provide partial compatibility.
- Modifying macOS launchd behavior in any way.
- Supporting multi-instance per user (one collector + one updater per user is the limit).
- Running the installer itself as a systemd service.
- Timer-based systemd activation (we use `Restart=on-failure` for persistence, not timers).

## Decisions

### Decision 1: sudo pre-check and current user identity

The installer and service management script check the execution context before attempting privileged operations:

```bash
# Check if current user has sudo/root privileges for service registration
check_sudo_access() {
    if [ "$(id -u)" -eq 0 ] || sudo -v 2>/dev/null; then
        return 0
    else
        echo "⚠️  No sudo access — service registration requires sudo."
        echo "   Falling back to nohup (no autostart on boot)."
        return 1
    fi
}
```

Root users are allowed — they install under `/root/` and have privileges by default. Non-root users need `sudo -v` to pass. If `sudo -v` fails, the installer proceeds with file installation but skips service registration (nohup fallback).

### Decision 2: Extended init system detection

Replace the current `detect_init_system()`. On Linux, check `sudo -v` instead of `id -u == 0`:

```bash
detect_init_system() {
    case "$(uname -s)" in
        Darwin) echo "launchd" ;;
        Linux)
            if ! sudo -n true 2>/dev/null; then
                echo "none"
                return
            fi
            if command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1; then
                echo "systemd"
            elif [ -d /etc/init.d ]; then
                echo "initd"
            else
                echo "none"
            fi
            ;;
        *) echo "none" ;;
    esac
}
```

Return values:
| Value | Meaning |
|---|---|
| `launchd` | macOS (unchanged) |
| `systemd` | Linux, systemd available, user has sudo → system-level unit via sudo |
| `initd` | Linux, no systemd, `/etc/init.d/` exists, user has sudo |
| `none` | No suitable init system, or no sudo access |

Uses `sudo -n true` (non-interactive) to check if sudo credentials are already cached, avoiding a password prompt during detection. The interactive `sudo -v` prompt happens once at installer start.

### Decision 3: Per-user service naming

All system-level service files include the current username in the filename:

| Init system | Collector | Updater |
|---|---|---|
| systemd | `/etc/systemd/system/loongsuite-pilot-<user>.service` | `/etc/systemd/system/loongsuite-pilot-updater-<user>.service` |
| init.d | `/etc/init.d/loongsuite-pilot-<user>` | `/etc/init.d/loongsuite-pilot-updater-<user>` |

The `<user>` is always `$(whoami)` — the current user running the installer.

### Decision 4: System-level systemd unit template

```ini
[Unit]
Description=LoongSuite Pilot (<user>)
After=network.target

[Service]
Type=simple
User=<user>
Group=<group>
ExecStart=<user_home>/.local/bin/loongsuite-pilot run
WorkingDirectory=<user_home>/.loongsuite-pilot
Environment=HOME=<user_home>
Environment=AGENT_DATA_COLLECTION_CONFIG=<user_home>/.loongsuite-pilot/config.json
Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Key points:
- `User=` / `Group=` directives (service runs as the current user, not root)
- `WantedBy=multi-user.target` instead of `default.target`
- `After=network.target` instead of `default.target`
- `Environment=HOME=<user_home>` (systemd doesn't set HOME for non-login services by default)
- All paths are absolute, resolved at install time via `getent passwd` or `$HOME`
- `LimitNOFILE=65536` to prevent "Too many open files" in Node.js
- **Written via `sudo tee`** — not direct file write (since current user is not root)

### Decision 5: init.d script template

The generated script follows LSB conventions with chkconfig compatibility:

```bash
#!/bin/bash
### BEGIN INIT INFO
# Provides:          loongsuite-pilot-<user>
# Required-Start:    $local_fs $network
# Required-Stop:     $local_fs $network
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Description:       LoongSuite Pilot data collector (<user>)
### END INIT INFO
# chkconfig: 2345 90 10

DAEMON_USER="<user>"
DAEMON_HOME="<user_home>"
DAEMON_BIN="<user_home>/.local/bin/loongsuite-pilot"
DAEMON_NAME="loongsuite-pilot-<user>"
PID_FILE="<user_home>/.loongsuite-pilot/loongsuite-pilot.pid"

do_start() { ... }
do_stop() { ... }
do_status() { ... }

case "$1" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart) do_stop; do_start ;;
    status)  do_status ;;
    *)       echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;
esac
```

User switching strategy in `do_start()`:
1. If `start-stop-daemon` is available (Debian/Ubuntu): `start-stop-daemon --start --chuid $DAEMON_USER --background --make-pidfile --pidfile $PID_FILE --exec ...`
2. Fallback: `su - $DAEMON_USER -c "..."` with manual PID file management

Written via **`sudo tee`**. Boot registration via `sudo chkconfig` or `sudo update-rc.d`.

### Decision 6: `autostart_install()` extended flow

All systemd/init.d commands are prefixed with `sudo`:

```
autostart_install()
├── launchd → (unchanged, no sudo needed)
├── systemd
│   ├── _write_systemd_system_unit <user>         # uses sudo tee
│   ├── _write_systemd_system_updater_unit <user>  # uses sudo tee
│   ├── sudo systemctl daemon-reload
│   ├── sudo systemctl enable --now loongsuite-pilot-<user>.service
│   └── sudo systemctl enable --now loongsuite-pilot-updater-<user>.service
├── initd
│   ├── _write_initd_script <user>           # uses sudo tee
│   ├── _write_initd_updater_script <user>    # uses sudo tee
│   ├── sudo chmod +x /etc/init.d/loongsuite-pilot-<user>
│   ├── sudo chkconfig --add ... OR sudo update-rc.d ... defaults
│   └── sudo /etc/init.d/loongsuite-pilot-<user> start
└── none → return 1 (nohup fallback in caller)
```

### Decision 7: `autostart_remove()` extended flow

```
autostart_remove()
├── launchd → (unchanged)
├── systemd
│   ├── sudo systemctl disable --now loongsuite-pilot-<user>.service
│   ├── sudo systemctl disable --now loongsuite-pilot-updater-<user>.service
│   ├── sudo rm -f /etc/systemd/system/loongsuite-pilot-<user>.service
│   ├── sudo rm -f /etc/systemd/system/loongsuite-pilot-updater-<user>.service
│   └── sudo systemctl daemon-reload
├── initd
│   ├── sudo /etc/init.d/loongsuite-pilot-<user> stop
│   ├── sudo /etc/init.d/loongsuite-pilot-updater-<user> stop
│   ├── sudo chkconfig --del ... OR sudo update-rc.d ... remove
│   ├── sudo rm -f /etc/init.d/loongsuite-pilot-<user>
│   └── sudo rm -f /etc/init.d/loongsuite-pilot-updater-<user>
└── none → no-op
```

### Decision 8: State persistence for service type

Same as before — store the init type in a marker file:

```
~/.loongsuite-pilot/init-type
```

Contents: one of `launchd`, `systemd`, `initd`, `nohup`.

Written by `autostart_install()`. Read by `autostart_remove()` and `autostart_status()` as an override when the marker file exists. This file is in the user's home directory, so no sudo needed to read/write it.

### Decision 9: Installer flow changes

Remove `--run-as-user` parameter. The install flow becomes:

```
cmd_install()
├── install files to ~/...      # as current user, correct ownership by default
├── check_sudo_access()         # root → always pass; non-root → sudo -v
│   ├── success → proceed to service registration
│   └── failure → warn, skip to nohup fallback
├── autostart_install()         # uses sudo internally for privileged ops
└── verify service is running
```

No `fix_ownership()` needed since the installer runs as the target user.

### Decision 10: Handling no-sudo install on Linux

When `sudo -v` fails on Linux:
- Print a warning: sudo access is required for service registration, falling back to nohup.
- Service will run but will not auto-start on boot.
- Suggest: ensure the user has sudo access and re-run the installer.

## Risks / Trade-offs

- **sudo credential timeout**: `sudo -v` caches credentials for a limited time (typically 5-15 minutes). Long-running installs may need to re-validate. The `sudo -n true` check in `detect_init_system()` uses non-interactive mode to avoid hanging.
- **init.d script variability**: Different distros have slightly different conventions. The dual-strategy (start-stop-daemon + su fallback) mitigates this.
- **getent not available**: Some minimal containers may not have `getent`. Fallback to `$HOME` is used.
- **Stale init-type marker**: If someone manually modifies the init system after installation, the marker file may be stale. The `autostart_remove()` function should attempt both the marker-indicated type and a fresh detection as a safety net.

## Migration Plan

1. **macOS**: No changes. Launchd behavior is untouched.
2. **Linux with existing systemd-user install**: On upgrade or re-install, the new system-level units supersede the old user-level units. Users should manually remove old `~/.config/systemd/user/` units if present.
3. **Linux fresh install**: Run `bash installer.sh install` as the target user. The installer uses `sudo` internally for systemd registration.
4. **Linux no-sudo install**: Falls back to nohup with a warning.
5. No config file migration needed — service registration is orthogonal to `config.json`.
6. The `init-type` marker file is created on first `autostart_install()` after the upgrade.
