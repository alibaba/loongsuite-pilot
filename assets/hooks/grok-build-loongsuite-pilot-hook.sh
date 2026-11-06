#!/usr/bin/env bash
set -u
EMPTY_RESULT='{}'
NATIVE_ARGS=('hook-process' 'grok-build')
EVENT="${1:-unknown}"
case "$EVENT" in stop|stop_failure|user_prompt_submit|session_end) ;; *) printf '%s\n' "$EMPTY_RESULT"; exit 0 ;; esac
NATIVE_ARGS+=("$EVENT")
HOOK_DIR="${BASH_SOURCE[0]%/*}"
[[ "$HOOK_DIR" != "${BASH_SOURCE[0]}" ]] || HOOK_DIR=.
if HOOK_DIR="$(cd -- "$HOOK_DIR" && pwd -P)" && source "$HOOK_DIR/shared/native.sh"; then
  pilot_invoke_native "$HOOK_DIR" "$EMPTY_RESULT" "${NATIVE_ARGS[@]}"
else
  printf '%s\n' '[loongsuite-pilot] native hook bootstrap failed' >&2
  [[ -z "$EMPTY_RESULT" ]] || printf '%s\n' "$EMPTY_RESULT"
fi
exit 0
