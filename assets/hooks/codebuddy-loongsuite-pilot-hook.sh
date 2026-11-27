#!/usr/bin/env bash
# CodeBuddy hook wrapper — mirrors workbuddy-loongsuite-pilot-hook.sh but
# points at codebuddy-hook-event-writer.mjs so events land under
# state/codebuddy/hook-events (kept separate from workbuddy sessions).
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
PROCESSOR="$SCRIPT_DIR/codebuddy-hook-event-writer.mjs"
SUBCOMMAND="${1:-unknown}"
NODE_BIN=""

# Minimum-version gate mirroring the shared resolver's PILOT_MIN_NODE_MAJOR.
# When the shared file was sourced it delegates to pilot_node_is_suitable so
# both paths enforce the exact same bar; a standalone deployment (no shared/
# directory) falls back to probing the major version directly.
pilot_hook_node_ok() {
  local bin="$1" major version
  if declare -F pilot_node_is_suitable >/dev/null 2>&1; then
    pilot_node_is_suitable "$bin"
    return
  fi
  [[ -x "$bin" ]] || return 1
  version="$("$bin" --version 2>/dev/null)" || return 1
  major="${version#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 18 ))
}

# Prefer the shared resolver: the installer writes the node pin under the
# configured data/cache directory, not necessarily $HOME/.loongsuite-pilot —
# a custom data dir with no system node must still find the managed runtime.
NODE_RUNTIME="$SCRIPT_DIR/shared/node-runtime.sh"
if [[ -f "$NODE_RUNTIME" ]]; then
  # shellcheck source=shared/node-runtime.sh
  source "$NODE_RUNTIME"
  NODE_BIN="$(resolve_pilot_node_bin || true)"
fi

# Fallbacks only run when the shared resolver returned nothing, and every
# candidate passes the same minimum-version gate. Overwriting the resolver's
# pick unconditionally would let an older Volta/Fnm/Homebrew node silently
# shadow the managed runtime and drop events (the writer needs >= Node 18).
if [[ -z "$NODE_BIN" ]]; then
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
    if [[ -n "$candidate" ]] && pilot_hook_node_ok "$candidate"; then
      NODE_BIN="$candidate"
      break
    fi
  done

  if [[ -z "$NODE_BIN" ]] && command -v node >/dev/null 2>&1; then
    if pilot_hook_node_ok "$(command -v node)"; then
      NODE_BIN="$(command -v node)"
    fi
  fi
fi

if [[ -n "$NODE_BIN" && -f "$PROCESSOR" ]]; then
  "$NODE_BIN" "$PROCESSOR" "$SUBCOMMAND" 2>/dev/null || true
else
  printf '{}\n'
fi
exit 0
