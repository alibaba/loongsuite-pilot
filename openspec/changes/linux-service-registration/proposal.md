## Why

The current installer and service management script (`loongsuite-pilot.sh`) support launchd on macOS and a nohup fallback on Linux. The existing systemd user-level support (`systemctl --user`) depends on an active user session and `loginctl enable-linger`, making it unreliable on headless servers. It will be replaced by system-level systemd registration.

Additionally, many Linux servers (older CentOS 6, some containers, Alpine with OpenRC) don't have systemd at all. These environments have no autostart support today.

For enterprise deployment scenarios, the installer needs to reliably register a boot-persistent service on Linux regardless of whether the target user is logged in, and support both modern (systemd system-level) and legacy (init.d/SysVinit) init systems.

## What Changes

- **Installer runs as the current user (including root).** All file installations (`~/.loongsuite-pilot`, `~/.local/bin/`) happen under the current user's `$HOME`, so file ownership is correct by default — no `fix_ownership` needed. Root users install under `/root/`.
- **Privileged operations use `sudo`.** Only systemd / init.d operations that require root (writing to `/etc/systemd/system/`, `systemctl enable/disable`, writing to `/etc/init.d/`) are elevated with `sudo`.
- **`sudo -v` pre-check.** Before any privileged operation, the installer validates that the current user has sudo access. If `sudo -v` fails, a clear error is printed and the installer falls back to nohup (no autostart).
- **Current user identity.** The installer records `$(whoami)` as the service user — no `--run-as-user` parameter needed since the current user is always the target user. Root is allowed.
- Replace the existing systemd user-level support with system-level systemd registration. Extend `detect_init_system()` to distinguish between systemd, init.d/SysVinit, and nohup fallback, with systemd prioritized over init.d.
- Add system-level systemd unit generation with per-user naming (`loongsuite-pilot-<user>.service`). The unit uses `User=` / `Group=` directives with absolute paths resolved at install time.
- Add `/etc/init.d/loongsuite-pilot-<user>` script generation with LSB headers compatible with both chkconfig (RHEL) and update-rc.d (Debian). The script runs the service as the target user via `start-stop-daemon --chuid` with fallback to `su -`.
- Update uninstall to clean up system-level systemd units and init.d scripts.
- Update `autostart_status` to report the new init system types.

## Capabilities

### New Capabilities

- `sudo-precheck`: Before attempting service registration, run `sudo -v` to verify the current user has sudo privileges. On failure, print a clear message and fall back to nohup.
- `current-user-identity`: Record the current user via `$(whoami)` (including root) and use this identity for all per-user naming.
- `systemd-system-level`: On a systemd-enabled Linux host, use `sudo` to write a system-level unit at `/etc/systemd/system/loongsuite-pilot-<user>.service` with `User=<user>` and absolute paths. Use `sudo systemctl` for daemon-reload/enable/disable. Includes corresponding updater unit.
- `initd-service`: When systemd is unavailable and `/etc/init.d/` exists, use `sudo` to write an LSB-compliant init.d script at `/etc/init.d/loongsuite-pilot-<user>`. Register for boot startup via `sudo chkconfig` or `sudo update-rc.d`. Script supports `start|stop|restart|status` and runs the service as the target user.

### Modified Capabilities

- `detect-init-system`: Extended to return `systemd`, `initd`, or `none` on Linux (was: `systemd` for user-level, `none`). Removes user-level systemd support. Checks `sudo -v` instead of `id -u == 0` to determine if privileged operations are available. Prioritizes systemd over init.d when both are available.
- `autostart-install`: Replaces systemd-user branch with system-level systemd; adds init.d branch. All privileged commands prefixed with `sudo`.
- `autostart-remove`: Extended to clean up system-level units and init.d scripts.
- `autostart-status`: Extended to report `systemd` (system-level) and `initd` states.
- `installer-uninstall`: Extended fallback cleanup to cover system-level units and init.d scripts.

## Impact

- Affected code areas:
  - `scripts/loongsuite-pilot.sh`: `detect_init_system()`, `autostart_install()`, `autostart_remove()`, `autostart_status()`, `cmd_stop()`, `cmd_restart_collector()`, new `_write_systemd_system_unit()`, new `_write_initd_script()`. All systemctl/init.d operations now prefixed with `sudo`.
  - `deploy/loongsuite-pilot-installer.sh`: Add `sudo -v` pre-check and current user validation in install flow. Remove `--run-as-user` parameter. `cmd_uninstall()` fallback cleanup uses `sudo`.
  - `deploy/loongsuite-pilot-installer-inner.sh`: Same changes mirrored.
- No breaking changes to existing macOS launchd behavior.
- **Breaking change on Linux**: existing systemd user-level installs (`systemctl --user`) are superseded by system-level registration.
- Non-sudo Linux installs fall back to nohup (no autostart) with a clear warning.
- **Removes the `--run-as-user` parameter** — the current user is always the target user, including root.
