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
"$NPM_BIN" install --production --silent 2>/dev/null || true

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
