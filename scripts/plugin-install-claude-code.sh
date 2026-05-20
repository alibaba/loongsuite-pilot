#!/usr/bin/env bash
# Transitional wrapper for Claude Code plugin installation.
# Called by PluginProbeStrategy with environment variables:
#   PILOT_DATA_DIR, PILOT_LOG_DIR, PILOT_NODE_BIN, PILOT_NPM_BIN
#
# Once the plugin's own scripts/install.sh reads these env vars,
# this wrapper can be deleted.
set -uo pipefail

DEST_DIR="$(pwd)"
NODE_BIN="${PILOT_NODE_BIN:-node}"
NPM_BIN="${PILOT_NPM_BIN:-npm}"
LOG_DIR="${PILOT_LOG_DIR:-}"

# 1. Install dependencies
if ! "$NPM_BIN" install --production --silent 2>/tmp/pilot-plugin-npm-err.log; then
    echo "npm install failed" >&2
    cat /tmp/pilot-plugin-npm-err.log >&2 2>/dev/null
    exit 1
fi

# 2. Register hooks in ~/.claude/settings.json
if [ -f "$DEST_DIR/bin/otel-claude-hook" ]; then
    "$NODE_BIN" "$DEST_DIR/bin/otel-claude-hook" install --user --no-alias --quiet 2>/dev/null || true
fi

# 3. Write otel-config.json (set log_dir to pilot's log directory)
if [ -n "$LOG_DIR" ]; then
    CONFIG="$HOME/.claude/otel-config.json"
    mkdir -p "$(dirname "$CONFIG")"
    "$NODE_BIN" -e "
const fs = require('fs');
const cfgPath = process.argv[1];
const logDir = process.argv[2];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch {}
cfg.log_enabled = true;
if (!cfg.log_dir) cfg.log_dir = logDir;
if (!cfg.log_filename_format) cfg.log_filename_format = 'hook';
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
" "$CONFIG" "$LOG_DIR"

    mkdir -p "$LOG_DIR"
fi

# 4. Place a no-op intercept.js stub at the legacy path.
#    Old installations injected NODE_OPTIONS="--require ~/.cache/opentelemetry.instrumentation.claude/intercept.js"
#    into shell profiles. After upgrade, uninstall.sh removes the real file and cleans up profiles,
#    but already-open terminal sessions still have NODE_OPTIONS set. Without this stub, any node
#    process in those sessions fails with MODULE_NOT_FOUND. The stub is harmless and avoids the error
#    until the user opens a new terminal.
LEGACY_INTERCEPT="$HOME/.cache/opentelemetry.instrumentation.claude/intercept.js"
if [ ! -f "$LEGACY_INTERCEPT" ]; then
    mkdir -p "$(dirname "$LEGACY_INTERCEPT")"
    echo "/* no-op stub for legacy NODE_OPTIONS --require */" > "$LEGACY_INTERCEPT"
fi
