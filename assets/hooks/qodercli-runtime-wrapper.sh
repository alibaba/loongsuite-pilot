#!/bin/sh
#
# Launch qodercli with the token intercept scoped to this process only.
#
# npm and bundled SDK qodercli distributions are Node.js entrypoints and require
# NODE_OPTIONS --import. Native qodercli distributions are Bun executables and
# require BUN_OPTIONS --preload. Set LOONGSUITE_QODERCLI_RUNTIME=node|bun to
# override auto-detection, or LOONGSUITE_QODERCLI_BIN to provide the real entry.

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd)
INTERCEPT_SCRIPT="$SCRIPT_DIR/qodercli-token-intercept.mjs"
QODERCLI_BIN="${LOONGSUITE_QODERCLI_BIN:-}"

if [ -z "$QODERCLI_BIN" ]; then
  QODERCLI_BIN=$(command -v qodercli 2>/dev/null || true)
fi

if [ -z "$QODERCLI_BIN" ]; then
  echo "loongsuite-pilot: qodercli executable not found" >&2
  exit 127
fi

QODERCLI_RUNTIME="${LOONGSUITE_QODERCLI_RUNTIME:-}"
if [ -z "$QODERCLI_RUNTIME" ]; then
  case "$QODERCLI_BIN" in
    *.js|*.cjs|*.mjs) QODERCLI_RUNTIME=node ;;
    *)
      if LC_ALL=C head -c 128 "$QODERCLI_BIN" 2>/dev/null | grep -aq '^#!.*node'; then
        QODERCLI_RUNTIME=node
      else
        QODERCLI_RUNTIME=bun
      fi
      ;;
  esac
fi

launch_qodercli() {
  if [ "$QODERCLI_RUNTIME" = "node" ]; then
    QODERCLI_NODE_BIN="${LOONGSUITE_QODERCLI_NODE_BIN:-}"
    if [ -z "$QODERCLI_NODE_BIN" ]; then
      QODERCLI_NODE_BIN=$(command -v node 2>/dev/null || true)
    fi
    if [ -z "$QODERCLI_NODE_BIN" ]; then
      echo "loongsuite-pilot: node executable not found for qodercli entry" >&2
      exit 127
    fi
    exec "$QODERCLI_NODE_BIN" "$QODERCLI_BIN" "$@"
  fi
  exec "$QODERCLI_BIN" "$@"
}

# Missing hook assets must never prevent qodercli from starting.
if [ ! -f "$INTERCEPT_SCRIPT" ]; then
  launch_qodercli "$@"
fi

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
