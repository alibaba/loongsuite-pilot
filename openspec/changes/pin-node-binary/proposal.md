## Why

Node.js version discovery is duplicated across 5 shell scripts with subtly different search orders and scoping. The installer (`deploy/*-installer*.sh`) uses only `command -v node`; the service script (`scripts/loongsuite-pilot.sh`) has a full `resolve_node()` with nvm/volta/fnm fallbacks; the Cursor hook and Qoder hook each carry their own `node_is_suitable()` + candidate lists — with different ordering. This means:

1. **Install-time node ≠ runtime node.** `npm install --production` compiles native modules against one node binary, but the service or hooks may run with a completely different one — potentially causing load failures.
2. **Hook scripts find different nodes.** The Cursor hook searches nvm before homebrew; the Qoder hook searches homebrew before nvm. On a machine with both, they silently pick different binaries.
3. **Service script has bare `node` leaks.** `cmd_start()` and `cmd_restart_collector()` nohup fallback paths use `node` without `resolve_node()`.

## What Changes

- **Pin the node binary path at install time** by writing the resolved absolute path to `~/.loongsuite-pilot/node-bin`.
- **Unify all runtime node resolution** to first read the pinned file, validate the binary still exists and meets the minimum version, and fall back to a single standardized search order if the pin is stale.
- **Auto-heal**: when the pinned node becomes unavailable (e.g. user uninstalled that version), the fallback search updates the pin file automatically.
- **Standardize the fallback search order** across all scripts: pinned → PATH → nvm (descending) → volta → fnm → homebrew → `~/.local/bin`.
- **Fix bare `node` references** in `scripts/loongsuite-pilot.sh` fallback paths.
- **Surface pinned node info** in `loongsuite-pilot info` output.

## Capabilities

### New Capabilities

- `node-pin`: Install-time pinning of node binary path in `~/.loongsuite-pilot/node-bin`, with runtime validation and auto-heal on stale pins.

### Modified Capabilities

- `installer`: `check_deps()` writes the pinned node path after validation; `npm install` and inline `node -e` use the pinned binary.
- `service-script`: `resolve_node()` reads pinned file first; bare `node` references replaced; `cmd_info()` displays pinned node path.
- `cursor-hook`: Node discovery replaced with pinned-first + unified fallback (read-only, never updates pin).
- `qoder-hook`: Same as cursor-hook — pinned-first + unified fallback (read-only).

## Impact

- Affected files:
  - `deploy/installer.sh` — write pin after `check_deps()`; use pinned node for `npm install` and `node -e`.
  - `deploy/installer-inner.sh` — same changes.
  - `scripts/loongsuite-pilot.sh` — `resolve_node()` reads pin; fix bare `node` in `cmd_start()`/`cmd_restart_collector()`; show pin in `cmd_info()`.
  - `assets/hooks/cursor-loongsuite-pilot-hook.sh` — replace node discovery with pin-first + unified fallback.
  - `assets/hooks/qoder-loongsuite-pilot-hook.sh` — same.
- No breaking changes: if pin file doesn't exist (pre-existing installs), all scripts fall back to the current search behavior.
- Upgrade path: running `install` or `upgrade` on an existing installation creates the pin file. No manual migration needed.
