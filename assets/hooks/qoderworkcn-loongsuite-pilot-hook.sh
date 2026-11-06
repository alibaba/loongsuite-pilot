#!/usr/bin/env bash
set -u
EMPTY_RESULT=''
NATIVE_ARGS=('hook-process' 'qoder-work-cn')
AGENT_ID="${1:-qoder-work-cn}"
NATIVE_ARGS+=('--agent-id' "$AGENT_ID" '--log-prefix' "$AGENT_ID")
HOOK_DIR="${BASH_SOURCE[0]%/*}"
[[ "$HOOK_DIR" != "${BASH_SOURCE[0]}" ]] || HOOK_DIR=.
if HOOK_DIR="$(cd -- "$HOOK_DIR" && pwd -P)" && source "$HOOK_DIR/shared/native.sh"; then
  pilot_invoke_native "$HOOK_DIR" "$EMPTY_RESULT" "${NATIVE_ARGS[@]}"
else
  printf '%s\n' '[loongsuite-pilot] native hook bootstrap failed' >&2
  [[ -z "$EMPTY_RESULT" ]] || printf '%s\n' "$EMPTY_RESULT"
fi
exit 0
