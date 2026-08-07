#!/usr/bin/env bash

# Shared Node.js resolver for macOS/Linux Hook entrypoints. Callers are
# responsible for setting LOONGSUITE_PILOT_DATA_DIR from their deployed path.
PILOT_MIN_NODE_MAJOR=18

pilot_node_is_app_bundle() {
  local resolved
  resolved="$(realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$resolved" in
    *.app/Contents/*) return 0 ;;
  esac
  return 1
}

pilot_node_is_suitable() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  pilot_node_is_app_bundle "$bin" && return 1
  local version major
  version="$("$bin" --version 2>/dev/null)" || return 1
  major="${version#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= PILOT_MIN_NODE_MAJOR ))
}

pilot_read_node_pin() {
  local pin_file="$1" pinned
  [[ -f "$pin_file" ]] || return 1
  pinned="$(tr -d '[:space:]' < "$pin_file" 2>/dev/null)"
  [[ -n "$pinned" ]] && pilot_node_is_suitable "$pinned" || return 1
  printf '%s\n' "$pinned"
}

resolve_pilot_node_bin() {
  local pin_file candidate
  local -a pin_files=() candidates=() nvm_candidates=()

  [[ -n "${LOONGSUITE_PILOT_CACHE_DIR:-}" ]] && pin_files+=("$LOONGSUITE_PILOT_CACHE_DIR/node-bin")
  [[ -n "${LOONGSUITE_PILOT_DATA_DIR:-}" ]] && pin_files+=("$LOONGSUITE_PILOT_DATA_DIR/node-bin")
  pin_files+=("$HOME/.loongsuite-pilot/node-bin")
  for pin_file in "${pin_files[@]}"; do
    candidate="$(pilot_read_node_pin "$pin_file" 2>/dev/null)" || continue
    printf '%s\n' "$candidate"
    return 0
  done

  nvm_candidates=("$HOME/.nvm/versions/node"/*/bin/node)
  for (( i=${#nvm_candidates[@]}-1; i>=0; i-- )); do
    candidates+=("${nvm_candidates[i]}")
  done
  candidates+=(
    "$HOME/.fnm/aliases/default/bin/node"
    "$HOME/.local/share/fnm/aliases/default/bin/node"
    "$HOME/.volta/bin/node"
    /opt/homebrew/bin/node
    /usr/local/bin/node
    "$HOME/.local/bin/node"
  )
  if command -v node >/dev/null 2>&1; then candidates+=("$(command -v node)"); fi
  for candidate in "${candidates[@]}"; do
    if pilot_node_is_suitable "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}
