## Context

The `loongsuite-pilot.sh` service management script is the single entry point for starting, stopping, and managing the loongsuite-pilot service. It already handles macOS launchd and Linux systemd user-level services. The installer (`installer.sh`) orchestrates first-time install and calls `loongsuite-pilot start`, which delegates to `autostart_install()`.

Key constraint: multiple OS users on the same Linux host may each have their own loongsuite-pilot installation. User-level systemd units are inherently per-user; system-level units use per-user naming to prevent conflicts.

**Key design shift**: Linux defaults to **systemd user-level** service (`systemctl --user`). This requires no sudo and works out-of-the-box. To ensure the service survives user session logout, `loginctl enable-linger` is attempted. System-level service registration (system-level systemd or init.d) is only activated via an explicit `--system-service` parameter — all sudo privilege checks are gated behind this flag.

All changes are in shell scripts — no TypeScript/Node.js changes required (logging changes are handled separately).

## Goals / Non-Goals

**Goals:**

- Keep systemd user-level service as the default on Linux — no sudo required for normal operation.
- Attempt `loginctl enable-linger <user>` to ensure user-level services persist after session logout. If linger cannot be enabled (no permission), warn the user but proceed.
- Add `--system-service` parameter to opt-in to system-level systemd (or init.d fallback) registration. Only this path requires sudo.
- When `--system-service` is specified: add `sudo -v` pre-check, fall back to user-level service if sudo is unavailable.
- Support init.d/SysVinit service registration as fallback when systemd is unavailable and `--system-service` is specified.
- Prioritize systemd over init.d when both are available (in system-service mode).
- Clean up all registered services on uninstall (both user-level and system-level if applicable).

**Non-Goals:**

- OpenRC support (Alpine) — could be added later, init.d scripts provide partial compatibility.
- Modifying macOS launchd behavior in any way.
- Supporting multi-instance per user (one collector + one updater per user is the limit).
- Running the installer itself as a systemd service.
- Timer-based systemd activation (we use `Restart=on-failure` for persistence, not timers).

## Decisions

### Decision 1: Default to systemd user-level service (no sudo)

Linux defaults to **systemd user-level** service via `systemctl --user`. This is the unprivileged path that requires no sudo:

- Unit files live in `~/.config/systemd/user/`
- Managed via `systemctl --user enable/start/stop/disable`
- No root or sudo needed
- Inherently per-user (no naming conflicts)

For root users, user-level systemd is not available; they always use system-level service (equivalent to `--system-service`).

### Decision 2: `loginctl enable-linger` for session persistence

By default, systemd user-level services are tied to the user's login session — they stop when all sessions end. To make the service survive logout:

```bash
enable_linger() {
    local user
    user="$(whoami)"
    if loginctl enable-linger "$user" 2>/dev/null; then
        echo "✓ Linger enabled — service will persist after logout."
        return 0
    else
        echo "⚠️  Cannot enable linger (requires polkit policy or root privilege)."
        echo "   Service may stop when you log out."
        echo "   To fix: run 'sudo loginctl enable-linger $user' or use --system-service."
        return 1
    fi
}
```

Only attempts direct `loginctl enable-linger` — works if the distro's polkit policy allows users to enable their own linger (e.g., Ubuntu 22.04+ permits this by default). No `sudo` of any form (`sudo -v`, `sudo -n`, etc.) is invoked in the default path. If it fails, warn the user and suggest manual remediation or `--system-service`.

### Decision 3: `--system-service` parameter for system-level registration

An explicit `--system-service` flag opts in to system-level service registration:

```bash
loongsuite-pilot start --system-service
# or during install:
bash installer.sh install --system-service
```

When `--system-service` is specified:
- `sudo -v` pre-check is performed
- System-level systemd unit (or init.d fallback) is created
- All `sudo` commands are executed
- If sudo check fails, fall back to user-level service (not nohup)

When `--system-service` is **not** specified (default):
- **No sudo of any form** (`sudo -v`, `sudo -n`, `sudo <cmd>`) is ever invoked
- User-level systemd is used
- `loginctl enable-linger` is attempted directly (without sudo; may fail if polkit disallows)

### Decision 4: sudo pre-check (only with `--system-service`)

```bash
check_sudo_access() {
    if [ "$(id -u)" -eq 0 ]; then
        return 0
    fi
    if sudo -v 2>/dev/null; then
        return 0
    else
        echo "⚠️  No sudo access — cannot register system-level service."
        echo "   Falling back to user-level systemd service."
        return 1
    fi
}
```

This function is **only called** when `--system-service` is specified. The default user-level path never triggers sudo.

### Decision 5: Init system detection (mode-aware)

```bash
detect_init_system() {
    local system_service="${1:-false}"
    case "$(uname -s)" in
        Darwin) echo "launchd" ;;
        Linux)
            if [ "$system_service" = "true" ]; then
                # System-level: requires sudo, checks system init
                if ! check_sudo_access; then
                    echo "systemd-user"  # fallback
                    return
                fi
                if command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1; then
                    echo "systemd-system"
                elif [ -d /etc/init.d ]; then
                    echo "initd"
                else
                    echo "systemd-user"  # fallback
                fi
            else
                # Default: user-level systemd
                if command -v systemctl &>/dev/null && systemctl --user --version &>/dev/null 2>&1; then
                    echo "systemd-user"
                else
                    echo "none"
                fi
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
| `systemd-user` | Linux, user-level systemd (default, no sudo) |
| `systemd-system` | Linux, system-level systemd (`--system-service`, requires sudo) |
| `initd` | Linux, no systemd, init.d fallback (`--system-service`, requires sudo) |
| `none` | No suitable init system available |

### Decision 6: User-level systemd unit template (default)

```ini
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
```

Key points:
- `%h` expands to the user's home directory (systemd user-level specifier)
- No `User=`/`Group=` directives (user-level services always run as the owning user)
- `WantedBy=default.target` (user session target)
- No `sudo tee` — written directly to `~/.config/systemd/user/`
- `LimitNOFILE=65536` to prevent "Too many open files" in Node.js

Unit file paths:
| Service | Path |
|---|---|
| Collector | `~/.config/systemd/user/loongsuite-pilot.service` |
| Updater | `~/.config/systemd/user/loongsuite-pilot-updater.service` |

### Decision 7: System-level systemd unit template (`--system-service` only)

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
- `User=` / `Group=` directives (service runs as the target user, not root)
- `WantedBy=multi-user.target` (system boot target)
- `After=network.target`
- `Environment=HOME=<user_home>` (systemd doesn't set HOME for non-login services)
- All paths are absolute, resolved at install time
- **Written via `sudo tee`**

System-level unit file paths (per-user naming to avoid conflicts):
| Service | Path |
|---|---|
| Collector | `/etc/systemd/system/loongsuite-pilot-<user>.service` |
| Updater | `/etc/systemd/system/loongsuite-pilot-updater-<user>.service` |

### Decision 8: init.d script template (`--system-service` only)

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

### Decision 9: `autostart_install()` extended flow

```
autostart_install(system_service=false)
├── launchd → (unchanged, no sudo needed)
├── systemd-user (default)
│   ├── mkdir -p ~/.config/systemd/user/
│   ├── _write_systemd_user_unit              # direct write, no sudo
│   ├── _write_systemd_user_updater_unit      # direct write, no sudo
│   ├── systemctl --user daemon-reload
│   ├── systemctl --user enable --now loongsuite-pilot.service
│   ├── systemctl --user enable --now loongsuite-pilot-updater.service
│   └── enable_linger()                       # best-effort, may warn
├── systemd-system (--system-service)
│   ├── _write_systemd_system_unit <user>         # sudo tee
│   ├── _write_systemd_system_updater_unit <user>  # sudo tee
│   ├── sudo systemctl daemon-reload
│   ├── sudo systemctl enable --now loongsuite-pilot-<user>.service
│   └── sudo systemctl enable --now loongsuite-pilot-updater-<user>.service
├── initd (--system-service, no systemd)
│   ├── _write_initd_script <user>           # sudo tee
│   ├── _write_initd_updater_script <user>    # sudo tee
│   ├── sudo chmod +x /etc/init.d/loongsuite-pilot-<user>
│   ├── sudo chkconfig --add ... OR sudo update-rc.d ... defaults
│   └── sudo /etc/init.d/loongsuite-pilot-<user> start
└── none → return 1 (nohup fallback in caller)
```

### Decision 10: `autostart_remove()` extended flow

```
autostart_remove()
├── launchd → (unchanged)
├── systemd-user
│   ├── systemctl --user disable --now loongsuite-pilot.service
│   ├── systemctl --user disable --now loongsuite-pilot-updater.service
│   ├── rm -f ~/.config/systemd/user/loongsuite-pilot.service
│   ├── rm -f ~/.config/systemd/user/loongsuite-pilot-updater.service
│   └── systemctl --user daemon-reload
├── systemd-system
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

### Decision 11: State persistence for service type

Store the init type in a marker file:

```
~/.loongsuite-pilot/init-type
```

Contents: one of `launchd`, `systemd-user`, `systemd-system`, `initd`, `nohup`.

Written by `autostart_install()`. Read by `autostart_remove()` and `autostart_status()` as an override when the marker file exists. This file is in the user's home directory, so no sudo needed to read/write it.

### Decision 12: Installer flow changes

```
cmd_install(--system-service?)
├── install files to ~/...              # as current user, no sudo
├── if --system-service:
│   ├── check_sudo_access()            # root → always pass; non-root → sudo -v
│   │   ├── success → system-level registration
│   │   └── failure → warn, fall back to user-level
│   └── autostart_install(system_service=true)
├── else (default):
│   └── autostart_install(system_service=false)  # user-level, no sudo
└── verify service is running
```

### Decision 13: Root user special case

When the installer runs as root (`id -u == 0`):
- User-level systemd is not available (root doesn't have a user session by default)
- Automatically behaves as if `--system-service` was specified
- No `sudo` prefix needed (already root)
- Service files go to `/etc/systemd/system/loongsuite-pilot-root.service`

## Risks / Trade-offs

- **Linger not available**: On some minimal or locked-down systems, `loginctl enable-linger` may not be available or permitted. In this case the user-level service stops on logout. Mitigation: clear warning message with instructions to either get linger enabled or use `--system-service`.
- **User-level systemd not available**: Some older distros or containers don't have user-level systemd. Detection falls through to `none`, triggering nohup fallback. Users can use `--system-service` if they have sudo.
- **sudo credential timeout** (system-service mode only): `sudo -v` caches credentials for a limited time (typically 5-15 minutes). Long-running installs may need to re-validate.
- **init.d script variability** (system-service mode only): Different distros have slightly different conventions. The dual-strategy (start-stop-daemon + su fallback) mitigates this.
- **Stale init-type marker**: If someone manually modifies the init system after installation, the marker file may be stale. The `autostart_remove()` function should attempt both the marker-indicated type and a fresh detection as a safety net.
- **Root user edge case**: Root doesn't typically have a user session, so user-level systemd won't work. The automatic fallback to system-level is the correct behavior.

## Migration Plan

1. **macOS**: No changes. Launchd behavior is untouched.
2. **Linux with existing systemd-user install**: Units stay in place. The new code continues to manage them as `systemd-user` type. No migration needed.
3. **Linux with existing system-level install** (if any from manual setup): The `init-type` marker file determines cleanup strategy. If no marker exists, detection is used.
4. **Linux fresh install (default)**: Run `bash installer.sh install` as the target user. No sudo needed. User-level systemd + linger.
5. **Linux fresh install (system-service)**: Run `bash installer.sh install --system-service` as the target user. Sudo is prompted.
6. No config file migration needed — service registration is orthogonal to `config.json`.
7. The `init-type` marker file is created on first `autostart_install()` after the upgrade.
