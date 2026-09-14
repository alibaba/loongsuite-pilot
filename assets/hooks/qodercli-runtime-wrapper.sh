#!/bin/sh
#
# Launch a Qoder CLI with the token intercept scoped to this process only.
#
# Serves both product lines: LOONGSUITE_QODERCLI_FLAVOR selects which one, and
# defaults to qodercli so an rc block written by an older install keeps working.
# The rc block installed for the CN build sets it to qoderclicn.
#
# npm and bundled SDK distributions are Node.js entrypoints and require
# NODE_OPTIONS --import. Native distributions are Bun executables and require
# BUN_OPTIONS --preload. Set <FLAVOR>_RUNTIME=node|bun to override
# auto-detection, or <FLAVOR>_BIN to provide the real entry, where <FLAVOR> is
# LOONGSUITE_QODERCLI or LOONGSUITE_QODERCLICN. The names are per flavor on
# purpose: a value exported for one product line must not redirect the other.

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd)
INTERCEPT_SCRIPT="$SCRIPT_DIR/qodercli-token-intercept.mjs"
QODERCLI_FLAVOR="${LOONGSUITE_QODERCLI_FLAVOR:-qodercli}"
FLAVOR_VAR=$(printf '%s' "$QODERCLI_FLAVOR" | tr 'a-z-' 'A-Z_')
INTERCEPT_FILE_NAME="${LOONGSUITE_INTERCEPT_FILE:-${QODERCLI_FLAVOR}-intercept.jsonl}"

eval "QODERCLI_BIN=\${LOONGSUITE_${FLAVOR_VAR}_BIN:-}"

if [ -z "$QODERCLI_BIN" ]; then
  QODERCLI_BIN=$(command -v "$QODERCLI_FLAVOR" 2>/dev/null || true)
fi

if [ -z "$QODERCLI_BIN" ]; then
  echo "loongsuite-pilot: $QODERCLI_FLAVOR executable not found" >&2
  exit 127
fi

# True for a readable file that opens with no shebang and holds no NUL byte.
# Such a file is a Node entrypoint: a Bun executable is compiled and carries NUL
# bytes in its header, and anything the kernel can launch on its own names an
# interpreter on the first line. Reading the file also follows the symlink a PATH
# entry usually is, so no path resolution is needed to reach the real bytes.
# A file we cannot read yields no evidence and is left to the caller's fallback.
is_shebangless_text() {
  LC_ALL=C head -c 2 "$1" 2>/dev/null | grep -aq '^#!' && return 1
  _read=$(LC_ALL=C head -c 128 "$1" 2>/dev/null | wc -c | tr -d ' ')
  [ "$_read" -gt 0 ] || return 1
  _text=$(LC_ALL=C head -c 128 "$1" 2>/dev/null | LC_ALL=C tr -d '\000' | wc -c | tr -d ' ')
  [ "$_read" = "$_text" ]
}

eval "QODERCLI_RUNTIME=\${LOONGSUITE_${FLAVOR_VAR}_RUNTIME:-}"
if [ -z "$QODERCLI_RUNTIME" ]; then
  case "$QODERCLI_BIN" in
    *.js|*.cjs|*.mjs) QODERCLI_RUNTIME=node ;;
    *)
      if LC_ALL=C head -c 128 "$QODERCLI_BIN" 2>/dev/null | grep -aq '^#!.*node'; then
        QODERCLI_RUNTIME=node
      elif is_shebangless_text "$QODERCLI_BIN"; then
        # A PATH entry's name carries no extension, so the arm above is all that
        # stood between a bundled entry and the Bun branch, which exec's the file
        # directly: the kernel refuses JS text and the CLI never starts.
        QODERCLI_RUNTIME=node
      else
        QODERCLI_RUNTIME=bun
      fi
      ;;
  esac
fi

launch_qodercli() {
  if [ "$QODERCLI_RUNTIME" = "node" ]; then
    eval "QODERCLI_NODE_BIN=\${LOONGSUITE_${FLAVOR_VAR}_NODE_BIN:-}"
    if [ -z "$QODERCLI_NODE_BIN" ]; then
      QODERCLI_NODE_BIN=$(command -v node 2>/dev/null || true)
    fi
    if [ -z "$QODERCLI_NODE_BIN" ]; then
      echo "loongsuite-pilot: node executable not found for $QODERCLI_FLAVOR entry" >&2
      exit 127
    fi
    exec "$QODERCLI_NODE_BIN" "$QODERCLI_BIN" "$@"
  fi
  exec "$QODERCLI_BIN" "$@"
}

# Missing hook assets must never prevent the CLI from starting.
if [ ! -f "$INTERCEPT_SCRIPT" ]; then
  launch_qodercli "$@"
fi

# Read by the preload script to pick its output file.
export LOONGSUITE_INTERCEPT_FILE="$INTERCEPT_FILE_NAME"

if [ "$QODERCLI_RUNTIME" = "node" ]; then
  PILOT_PRELOAD_OPTION="--import=$INTERCEPT_SCRIPT"
  case " ${NODE_OPTIONS:-} " in
    *" $PILOT_PRELOAD_OPTION "*) ;;
    *) NODE_OPTIONS="$PILOT_PRELOAD_OPTION${NODE_OPTIONS:+ $NODE_OPTIONS}" ;;
  esac
  export NODE_OPTIONS
else
  PILOT_PRELOAD_OPTION="--preload=$INTERCEPT_SCRIPT"
  case " ${BUN_OPTIONS:-} " in
    *" $PILOT_PRELOAD_OPTION "*) ;;
    *) BUN_OPTIONS="$PILOT_PRELOAD_OPTION${BUN_OPTIONS:+ $BUN_OPTIONS}" ;;
  esac
  export BUN_OPTIONS
fi

launch_qodercli "$@"
