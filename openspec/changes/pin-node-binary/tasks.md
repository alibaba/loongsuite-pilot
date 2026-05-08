## 1. Service Script — Unified resolve_node() and bare-node fixes

- [x] 1.1 In `scripts/loongsuite-pilot.sh`, refactor `resolve_node()` to read `~/.loongsuite-pilot/node-bin` as the first candidate. If the file exists and the binary passes `_node_is_suitable()`, return it immediately.
- [x] 1.2 After the fallback search succeeds, auto-heal: write the found binary's realpath back to `~/.loongsuite-pilot/node-bin` (create parent dir if needed, ignore write errors).
- [x] 1.3 Standardize the fallback candidate order in `resolve_node()` to: PATH → nvm (descending) → volta → fnm → homebrew (`/opt/homebrew/bin/node`, `/usr/local/bin/node`) → `~/.local/bin/node`.
- [x] 1.4 Fix `cmd_start()` nohup fallback (line ~286): replace bare `node "$entry"` with `"$node_bin" "$entry"` where `node_bin` is resolved via `resolve_node()`.
- [x] 1.5 Fix `cmd_restart_collector()` nohup fallback (line ~445): same replacement as 1.4.
- [x] 1.6 Add pinned node info to `cmd_info()`: read `~/.loongsuite-pilot/node-bin` and display `node_bin=<path>` and `node_version=<version>`. If pin file is missing, show `node_bin=not pinned`.

## 2. Installer — Pin node at install time

- [x] 2.1 In `deploy/loongsuite-pilot-installer.sh`, after `check_deps()` passes, resolve the node binary's real absolute path using `realpath` (with `readlink -f` fallback) and write it to `$DATA_DIR/node-bin`.
- [x] 2.2 Set `NODE_BIN` and `NPM_BIN="$(dirname "$NODE_BIN")/npm"` from the pin file. Fall back to `command -v npm` if `$NPM_BIN` doesn't exist.
- [x] 2.3 Replace all `node -e "..."` calls in the installer with `"$NODE_BIN" -e "..."`.
- [x] 2.4 Replace `npm install --production` in `deploy_package()` with `"$NPM_BIN" install --production`.
- [x] 2.5 Replace `node scripts/postinstall.js` in `deploy_package()` with `"$NODE_BIN" scripts/postinstall.js`.
- [x] 2.6 Apply the same changes (2.1–2.5) to `deploy/loongsuite-pilot-installer-inner.sh`.

## 3. Hook Scripts — Read pin, unified fallback (read-only)

- [x] 3.1 In `assets/hooks/cursor-loongsuite-pilot-hook.sh`, refactor node discovery: first read `~/.loongsuite-pilot/node-bin` and validate with `node_is_suitable()`. If valid, use it. Otherwise fall through to the unified fallback order.
- [x] 3.2 Standardize the Cursor hook's fallback candidate order to match Decision 2: PATH → nvm (descending) → volta → fnm → homebrew → `~/.local/bin/node`. Do NOT write back to the pin file.
- [x] 3.3 In `assets/hooks/qoder-loongsuite-pilot-hook.sh`, apply the same changes as 3.1–3.2.

## 4. Verification

- [ ] 4.1 Manual test: fresh `install` → verify `~/.loongsuite-pilot/node-bin` exists with correct absolute path, `loongsuite-pilot info` shows `node_bin=` and `node_version=`.
- [ ] 4.2 Manual test: rename/remove the pinned node binary → run `loongsuite-pilot start` → verify auto-heal updates the pin file to a new valid node, service starts successfully.
- [ ] 4.3 Manual test: remove `~/.loongsuite-pilot/node-bin` entirely → verify all scripts (service, hooks) fall back gracefully and service starts.
- [ ] 4.4 Manual test: run `upgrade` → verify pin file is re-written with the node used for `npm install`.
