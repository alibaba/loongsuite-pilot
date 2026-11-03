#!/usr/bin/env bash
set -u
EMPTY_RESULT='{}'
NATIVE_ARGS=('hook-process' 'qwen-work-cn')
NATIVE_ARGS+=('--agent-id' 'qwen-work-cn' '--log-prefix' 'qwen-work-cn')
HOOK_DIR="${BASH_SOURCE[0]%/*}"
[[ "$HOOK_DIR" != "${BASH_SOURCE[0]}" ]] || HOOK_DIR=.
if HOOK_DIR="$(cd -- "$HOOK_DIR" && pwd -P)" && source "$HOOK_DIR/shared/native.sh"; then
  # The installed dedicated entrypoint owns its data root even when the caller
  # inherited a stale Pilot environment. Source/package assets keep explicit env.
  if [[ "${HOOK_DIR##*/}" == hooks && "${HOOK_DIR%/*}" != */assets ]]; then
    export LOONGSUITE_PILOT_DATA_DIR="${HOOK_DIR%/*}"
  fi
  pilot_invoke_native "$HOOK_DIR" "$EMPTY_RESULT" "${NATIVE_ARGS[@]}"
else
  printf '%s\n' '[loongsuite-pilot] native hook bootstrap failed' >&2
  [[ -z "$EMPTY_RESULT" ]] || printf '%s\n' "$EMPTY_RESULT"
fi
exit 0
