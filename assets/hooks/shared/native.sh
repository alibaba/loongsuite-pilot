#!/usr/bin/env bash

pilot_binary_valid() {
  [[ "$1" == /* && -f "$1" && -x "$1" && ! -L "$1" ]]
}

pilot_resolve_binary() {
  local hook_dir="$1" parent="${1%/*}" binary version cache
  if [[ -n "${LOONGSUITE_PILOT_BIN:-}" ]]; then
    pilot_binary_valid "$LOONGSUITE_PILOT_BIN" || return 1
    printf '%s' "$LOONGSUITE_PILOT_BIN"
    return 0
  fi
  if [[ "${parent##*/}" == assets && -f "${parent%/*}/runtime-manifest.json" ]]; then
    binary="${parent%/*}/bin/loongsuite-pilot"
    pilot_binary_valid "$binary" || return 1
    printf '%s' "$binary"
    return 0
  fi
  if [[ -f "$hook_dir/pilot-bin" ]]; then
    binary="$(<"$hook_dir/pilot-bin")"
    pilot_binary_valid "$binary" || return 1
    printf '%s' "$binary"
    return 0
  fi
  local data="${LOONGSUITE_PILOT_DATA_DIR:-$parent}"
  cache="${LOONGSUITE_PILOT_CACHE_DIR:-$data}"
  if [[ -f "$cache/current" ]]; then
    version="$(<"$cache/current")"
    [[ "$version" =~ ^[[:space:]]*([A-Za-z0-9._-]+)[[:space:]]*$ ]] || return 1
    version="${BASH_REMATCH[1]}"
    [[ "$version" != . && "$version" != .. ]] || return 1
    [[ ! -L "$cache/versions" && ! -L "$cache/versions/$version" && ! -L "$cache/versions/$version/bin" ]] || return 1
    binary="$cache/versions/$version/bin/loongsuite-pilot"
  else
    binary="$data/bin/loongsuite-pilot"
  fi
  pilot_binary_valid "$binary" || return 1
  printf '%s' "$binary"
}

pilot_invoke_native() {
  local hook_dir="$1" empty="$2" binary result
  shift 2
  if [[ -t 0 ]]; then
    [[ -z "$empty" ]] || printf '%s\n' "$empty"
    return 0
  fi
  local parent="${hook_dir%/*}"
  if [[ -z "${LOONGSUITE_PILOT_DATA_DIR:-}" && "${parent##*/}" != assets ]]; then
    export LOONGSUITE_PILOT_DATA_DIR="$parent"
  fi
  if ! binary="$(pilot_resolve_binary "$hook_dir")"; then
    printf '%s\n' '[loongsuite-pilot] native binary unavailable' >&2
    [[ -z "$empty" ]] || printf '%s\n' "$empty"
    return 0
  fi
  if result="$("$binary" "$@")"; then
    if [[ -n "$result" ]]; then printf '%s\n' "$result"
    elif [[ -n "$empty" ]]; then printf '%s\n' "$empty"; fi
  else
    printf '%s\n' '[loongsuite-pilot] native hook failed' >&2
    [[ -z "$empty" ]] || printf '%s\n' "$empty"
  fi
  return 0
}
