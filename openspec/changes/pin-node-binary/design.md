## Context

Node.js binary resolution is duplicated in 5 shell scripts with inconsistent search orders. The installer checks only `command -v node`; the service script has `resolve_node()` with nvm/volta/fnm fallbacks; the two hook scripts each carry independent candidate lists with different ordering. There is no shared state between install-time and runtime, so the node used to `npm install` native modules may differ from the node that runs the service or hooks.

The service script (`scripts/loongsuite-pilot.sh`) also has two code paths (`cmd_start()` line 286, `cmd_restart_collector()` line 445) that use bare `node` instead of `resolve_node()`.

## Goals / Non-Goals

**Goals:**

- Pin the node binary absolute path at install time in a well-known file (`~/.loongsuite-pilot/node-bin`).
- All runtime consumers (service script, hooks) read the pin first, falling back to a unified search order if the pin is stale.
- Auto-heal: when the pinned binary is gone or no longer meets the minimum version, the fallback search runs and updates the pin file (service script and installer only; hooks are read-only).
- Standardize the fallback search order across all 5 scripts.
- Fix bare `node` references in the service script's nohup fallback paths.
- Display pinned node info in `loongsuite-pilot info`.
- Use the pinned node (and its co-located npm) for `npm install` during installation.

**Non-Goals:**

- Bundling or downloading a node binary — we rely on the user's installed node.
- Pinning npm separately — npm is derived from the pinned node's sibling path.
- Changing the minimum version requirement (stays at >= 18).
- Modifying any JavaScript/TypeScript source files — this change is shell-only.

## Decisions

### Decision 1: Pin file location and format

**File**: `~/.loongsuite-pilot/node-bin`

**Format**: Single line containing the absolute, symlink-resolved path to the node binary.

```
/Users/somebody/.nvm/versions/node/v22.12.0/bin/node
```

The path is resolved via `realpath` (or `readlink -f` fallback) to avoid storing symlinks that might later point to a different version (e.g. nvm's `default` alias changing).

**Why a separate file instead of config.json**: Hook scripts need to find node *before* they have node available to parse JSON. A plain text file can be read with `cat` in bash.

### Decision 2: Unified fallback search order

When the pin is missing or stale, all scripts use this order:

| Priority | Source | Rationale |
|---|---|---|
| 1 | Pinned file (`~/.loongsuite-pilot/node-bin`) | Our own controlled state |
| 2 | PATH (`command -v node`) | User's current shell default |
| 3 | nvm versions (descending) `~/.nvm/versions/node/*/bin/node` | Most common version manager, newest first |
| 4 | volta `~/.volta/bin/node` | Volta users' shim |
| 5 | fnm `~/.fnm/aliases/default/bin/node` | fnm users' default |
| 6 | homebrew `/opt/homebrew/bin/node` then `/usr/local/bin/node` | macOS common paths |
| 7 | `~/.local/bin/node` | Catch-all |

All candidates are validated with the same `_node_is_suitable()` check: binary exists, is executable, and reports major version >= 18.

### Decision 3: Who reads vs. who writes the pin file

| Script | Reads pin | Writes/updates pin | Rationale |
|---|---|---|---|
| Installer (`deploy/*-installer*.sh`) | No (creates fresh) | Yes — after `check_deps()` | Install time is the canonical pinning moment |
| Service script (`scripts/loongsuite-pilot.sh`) | Yes — in `resolve_node()` | Yes — auto-heal on stale pin | Long-running; should self-repair |
| Cursor hook (`assets/hooks/cursor-*.sh`) | Yes | No | Hooks run in IDE subprocesses with unpredictable env; should not mutate shared state |
| Qoder hook (`assets/hooks/qoder-*.sh`) | Yes | No | Same rationale as Cursor hook |

### Decision 4: Installer uses pinned node for npm install and node -e

After `check_deps()` writes the pin, the installer sets `NODE_BIN` and derives `NPM_BIN`:

```bash
NODE_BIN=$(cat "$DATA_DIR/node-bin")
NPM_BIN="$(dirname "$NODE_BIN")/npm"
```

All subsequent `node -e "..."` calls use `"$NODE_BIN" -e "..."`. The `npm install --production` call uses `"$NPM_BIN" install --production`. This ensures native modules are compiled against the same node that will run the service.

If `$NPM_BIN` doesn't exist (edge case), fall back to `command -v npm`.

### Decision 5: Upgrade re-pins

`cmd_upgrade` calls `check_deps()` which re-writes the pin file. This is correct because upgrade runs `npm install` which may recompile native modules — the pin should reflect the node used for that compilation.

### Decision 6: Fix bare `node` in service script

Two code paths in `scripts/loongsuite-pilot.sh` use bare `node` instead of `resolve_node()`:

- `cmd_start()` nohup fallback (line 286): `nohup node "$entry"` → `nohup "$node_bin" "$entry"`
- `cmd_restart_collector()` nohup fallback (line 445): same fix

Both paths will call `resolve_node()` first, same as `cmd_run()` already does.

### Decision 7: Display in `loongsuite-pilot info`

Add to `cmd_info()` output:

```
node_bin=/Users/somebody/.nvm/versions/node/v22.12.0/bin/node
node_version=v22.12.0
```

Read from the pin file. If the pin file doesn't exist or the binary is gone, show `node_bin=not pinned` and resolve dynamically for the version.

## Risks / Trade-offs

- **Stale pin after node uninstall**: Mitigated by auto-heal — `resolve_node()` detects the binary is gone, runs fallback, updates pin.
- **realpath not available on all systems**: Fall back to `readlink -f`, then to the raw path. Even a symlink path works; it just won't survive alias changes.
- **Hook scripts can't auto-heal**: By design — they are read-only consumers. If the pin goes stale and the hook can't find node via fallback either, it fails open (returns `{}`), which is the existing behavior.
- **Two installer files to maintain**: `deploy/loongsuite-pilot-installer.sh` and `deploy/loongsuite-pilot-installer-inner.sh` have near-identical logic. Both need the same changes. Consider extracting shared functions in a future change.
- **Pre-existing installs without pin file**: All scripts fall back to the current search logic — fully backward compatible. The pin file is created on next `install` or `upgrade`.

## Migration Plan

1. Deploy updated scripts — all include backward-compatible fallback.
2. Users running `install` or `upgrade` get the pin file created automatically.
3. Pre-existing installs continue to work without a pin file until next upgrade.
4. No manual action required.
