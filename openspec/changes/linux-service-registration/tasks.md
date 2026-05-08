## 1. sudo Pre-check & User Validation

- [x] 1.1 Add `validate_current_user()` function to `scripts/loongsuite-pilot.sh`: `whoami`, reject `root` with clear error message.
- [x] 1.2 Add `check_sudo_access()` function to `scripts/loongsuite-pilot.sh`: run `sudo -v`, return 0 on success, print warning and return 1 on failure.
- [x] 1.3 Add `validate_current_user()` and `check_sudo_access()` calls to installer scripts (`deploy/loongsuite-pilot-installer.sh` and `deploy/loongsuite-pilot-installer-inner.sh`) before service registration in `cmd_install()` and `cmd_upgrade()`.
- [x] 1.4 Remove `--run-as-user` parameter parsing from installer scripts (no longer needed). Remove `resolve_run_as_user()` — replace usages with `$(whoami)`.

## 2. Init System Detection

- [x] 2.1 Update `detect_init_system()` in `scripts/loongsuite-pilot.sh`: replace `id -u == 0` check with `sudo -n true 2>/dev/null` to determine if privileged operations are available without an interactive prompt.
- [x] 2.2 Keep `init-type` marker file support unchanged: write `$DATA_DIR/init-type` in `autostart_install()`, read it in `autostart_remove()` and `autostart_status()`.
- [x] 2.3 Remove `_clean_legacy_systemd_user_units()` — user-level systemd cleanup is no longer supported.

## 3. System-level Systemd Units (sudo)

- [x] 3.1 Update `_write_systemd_system_unit()`: use `sudo tee` instead of direct write to `/etc/systemd/system/`. Unit content remains the same (User=, Group=, LimitNOFILE=65536, absolute paths).
- [x] 3.2 Update `_write_systemd_system_updater_unit()`: same `sudo tee` approach.
- [x] 3.3 Update all `systemctl` calls in `autostart_install()` systemd branch: prefix with `sudo` (`sudo systemctl daemon-reload`, `sudo systemctl enable --now`).
- [x] 3.4 Update all `systemctl` calls in `autostart_remove()` systemd branch: prefix with `sudo`.
- [x] 3.5 Update `systemctl` calls in `autostart_status()` systemd branch: prefix with `sudo`.
- [x] 3.6 Update `rm -f` of system-level unit files in `autostart_remove()`: prefix with `sudo`.

## 4. init.d Script Generation (sudo)

- [x] 4.1 Update `_write_initd_script()`: use `sudo tee` and `sudo chmod +x` instead of direct write.
- [x] 4.2 Update `_write_initd_updater_script()`: same approach.
- [x] 4.3 Update `_register_initd_boot()`: prefix `chkconfig`/`update-rc.d` with `sudo`.
- [x] 4.4 Update `_unregister_initd_boot()`: prefix with `sudo`.
- [x] 4.5 Update init.d start/stop calls in `autostart_install()`/`autostart_remove()`: prefix with `sudo`.

## 5. Stop & Restart Integration (sudo)

- [x] 5.1 Update `cmd_stop()` systemd branch: use `sudo systemctl stop`.
- [x] 5.2 Update `cmd_stop()` init.d branch: use `sudo /etc/init.d/... stop`.
- [x] 5.3 Update `cmd_restart_collector()` systemd branch: use `sudo systemctl stop/start`.
- [x] 5.4 Update `cmd_restart_collector()` init.d branch: use `sudo /etc/init.d/... stop/start`.

## 6. Installer Cleanup

- [x] 6.1 Remove `--run-as-user` parameter parsing and `RUN_AS_USER` variable from `deploy/loongsuite-pilot-installer.sh`.
- [x] 6.2 Remove `--run-as-user` parameter parsing from `deploy/loongsuite-pilot-installer-inner.sh`.
- [x] 6.3 Remove `fix_ownership()` function from installer scripts (no longer needed).
- [x] 6.4 Update `cmd_uninstall()` fallback cleanup to use `sudo` for system-level systemd units and init.d scripts.
- [x] 6.5 Mirror all changes to `deploy/loongsuite-pilot-installer-inner.sh`.

## 7. Testing

- [ ] 7.1 Manual test: install as non-root user with sudo access on a systemd-enabled Linux VM, verify `sudo -v` check passes, system-level unit is created via `sudo tee`, service starts and survives reboot.
- [ ] 7.2 Manual test: install as non-root user for two different users, verify both services coexist.
- [ ] 7.3 Manual test: install as non-root user without sudo access, verify nohup fallback with warning.
- [ ] 7.4 Manual test: attempt install as `root` directly, verify rejection with clear message.
- [ ] 7.5 Manual test: install on a non-systemd Linux environment, verify init.d via sudo.
- [ ] 7.6 Manual test: uninstall, verify `sudo` cleanup of system-level units/init.d scripts.
- [ ] 7.7 Manual test: upgrade from existing systemd-user install, verify new system-level units are created.
- [ ] 7.8 Verify macOS behavior is completely unchanged.
