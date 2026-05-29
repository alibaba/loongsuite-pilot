## 1. Core Infrastructure (user-level default)

- [x] 1.1 Refactor `detect_init_system()` to accept a `system_service` parameter. Default path: check for user-level systemd (`systemctl --user`). `--system-service` path: check sudo then system-level systemd/init.d. Return values: `systemd-user`, `systemd-system`, `initd`, `launchd`, `none`.
- [x] 1.2 Add `enable_linger()` function: attempt `loginctl enable-linger $(whoami)` directly (no sudo). Warn on failure with instructions.
- [x] 1.3 Add `_write_systemd_user_unit()` function: write unit to `~/.config/systemd/user/loongsuite-pilot.service` using `%h` specifiers, no sudo.
- [x] 1.4 Add `_write_systemd_user_updater_unit()` function: same approach for updater service.
- [x] 1.5 Add `is_managed_by_systemd_user()` check function: `systemctl --user is-enabled loongsuite-pilot.service`.
- [x] 1.6 Update `check_sudo_access()` to only be called when `--system-service` is active. Change message to suggest falling back to user-level service.

## 2. autostart_install / autostart_remove / autostart_status Refactor

- [x] 2.1 Refactor `autostart_install()` to accept a `system_service` parameter. Add `systemd-user` branch: mkdir user unit dir, write units, `systemctl --user daemon-reload`, `systemctl --user enable --now`, call `enable_linger()`. No sudo in this branch.
- [x] 2.2 Rename existing `systemd` branch to `systemd-system` — keep sudo logic unchanged.
- [x] 2.3 Update `INIT_TYPE_FILE` values: `systemd-user`, `systemd-system`, `initd`, `launchd`, `nohup`.
- [x] 2.4 Refactor `autostart_remove()` to handle `systemd-user` type: `systemctl --user disable --now`, remove user unit files, `systemctl --user daemon-reload`. No sudo.
- [x] 2.5 Update `autostart_status()` to handle `systemd-user` type: `systemctl --user is-enabled`. No sudo.

## 3. Command-level `--system-service` Gating

- [x] 3.1 Update `cmd_start()`: remove unconditional `check_sudo_access` call on Linux. Parse `--system-service` flag. Pass it to `autostart_install()`. Default path uses user-level systemd (no sudo).
- [x] 3.2 Update `cmd_stop()`: read `INIT_TYPE_FILE` to determine mode. Only use sudo for `systemd-system`/`initd`. User-level uses `systemctl --user stop`.
- [x] 3.3 Update `cmd_restart_collector()`: same pattern — read init-type, only sudo for system-level.
- [x] 3.4 Add `--system-service` parsing to the main dispatch (pass through to cmd_start).

## 4. Root User Special Case

- [x] 4.1 In `cmd_start()` / `autostart_install()`: if `id -u == 0`, automatically behave as `--system-service` (root has no user session). No sudo prefix needed (already root).

## 5. Installer Updates

- [x] 5.1 Add `--system-service` parameter parsing to `deploy/installer.sh`. Pass it through to `loongsuite-pilot start`.
- [x] 5.2 Move `check_sudo_access()` call in installer to only execute when `--system-service` is specified.
- [x] 5.3 Mirror changes to `deploy/installer-inner.sh`.

## 6. Testing

- [ ] 6.1 Manual test: install as non-root user (default), verify user-level systemd unit is created, service starts, `loginctl enable-linger` is attempted.
- [ ] 6.2 Manual test: install with `--system-service`, verify sudo prompt, system-level unit created.
- [ ] 6.3 Manual test: install as non-root without sudo + no `--system-service`, verify no sudo is ever invoked and user-level service works.
- [ ] 6.4 Manual test: install as root, verify auto-escalation to system-level without sudo prefix.
- [ ] 6.5 Manual test: stop/restart reads init-type marker correctly for both modes.
- [ ] 6.6 Manual test: uninstall cleans up the correct service type.
- [ ] 6.7 Verify macOS behavior is completely unchanged.
