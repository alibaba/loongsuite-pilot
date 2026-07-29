#!/usr/bin/env bash
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
PROCESSOR="$SCRIPT_DIR/workbuddy-hook-event-writer.mjs"
SUBCOMMAND="${1:-unknown}"
NODE_BIN=""

for candidate in \
  "$HOME/.loongsuite-pilot/node-bin" \
  "$HOME/.volta/bin/node" \
  "$HOME/.fnm/aliases/default/bin/node" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  "$HOME/.local/bin/node"
do
  if [[ "$candidate" == *.loongsuite-pilot/node-bin && -f "$candidate" ]]; then
    candidate="$(tr -d '[:space:]' < "$candidate" 2>/dev/null)"
  fi
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [[ -z "$NODE_BIN" ]] && command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [[ -n "$NODE_BIN" && -f "$PROCESSOR" ]]; then
  "$NODE_BIN" "$PROCESSOR" "$SUBCOMMAND" 2>/dev/null || true
else
  printf '{}\n'
fi
exit 0
