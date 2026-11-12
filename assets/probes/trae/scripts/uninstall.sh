#!/usr/bin/env bash
# Loongsuite Pilot — Trae plugin-probe uninstall script.
#
# Invoked by PluginProbeStrategy.deploy() before staging an update
# (src/deployment/plugin-probe-strategy.ts:109-117) and by undeploy()
# (plugin-probe-strategy.ts:185-194). Removes the PATH wrappers and the
# PATH injection block from shell rc files.
#
# Does NOT delete $PILOT_DATA/logs/trae — historical trace data must
# survive redeploys and uninstalls (coordinator requirement).

set -euo pipefail

AGENT_ID="trae"
PILOT_DATA_DIR="${PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
WRAPPER_DIR="$PILOT_DATA_DIR/bin"
TRAE_COMMANDS=(trae trae-cn)

# Remove the wrapper scripts themselves.
for cmd in "${TRAE_COMMANDS[@]}"; do
  wrapper="$WRAPPER_DIR/$cmd"
  if [[ -L "$wrapper" || -f "$wrapper" ]]; then
    rm -f "$wrapper"
  fi
done

# Strip the PATH injection block from each rc file. The block is delimited
# by a `# loongsuite-pilot trae plugin-probe PATH` marker; we delete that
# line and the following 4 lines (case/esac).
strip_rc_block() {
  local rc="$1"
  [[ -f "$rc" ]] || return 0
  if ! grep -q "# loongsuite-pilot trae plugin-probe PATH" "$rc"; then
    return 0
  fi
  # Use awk to drop the marker line + the next 4 lines.
  local tmp
  tmp="$(mktemp)"
  awk '
    /^# loongsuite-pilot trae plugin-probe PATH$/ { skip=5; next }
    skip > 0 { skip--; next }
    { print }
  ' "$rc" > "$tmp"
  cat "$tmp" > "$rc"
  rm -f "$tmp"
}

strip_rc_block "$HOME/.bashrc"
strip_rc_block "$HOME/.zshrc"
strip_rc_block "$HOME/.profile"

# Leave logs/ and probe.mjs alone — PluginProbeStrategy handles bundle
# replacement; logs must persist.

echo "[trae-plugin-probe] uninstalled. Wrappers removed from $WRAPPER_DIR."
echo "[trae-plugin-probe] historical traces under $PILOT_DATA_DIR/logs/$AGENT_ID preserved."

exit 0
