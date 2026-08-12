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

# Numeric-descending sort for Node version directories. GNU sort supports -V;
# BSD/macOS sort falls back to zero-padded numeric keys.
sort_version_dirs_desc() {
  if printf '' | sort -V >/dev/null 2>&1; then
    sort -rV
    return
  fi
  local dir version major minor patch
  while IFS= read -r dir; do
    version="${dir##*/}"; version="${version#node-v}"; version="${version#v}"
    IFS=. read -r major minor patch <<<"$version"
    [[ "$major" =~ ^([0-9]+) ]] && major="${BASH_REMATCH[1]}" || major=0
    [[ "$minor" =~ ^([0-9]+) ]] && minor="${BASH_REMATCH[1]}" || minor=0
    [[ "$patch" =~ ^([0-9]+) ]] && patch="${BASH_REMATCH[1]}" || patch=0
    printf '%04d.%04d.%04d|%s\n' "$major" "$minor" "$patch" "$dir"
  done | sort -r | cut -d'|' -f2-
}

resolve_pilot_node_bin() {
  local pin_file runtime_dir candidate dir
  local -a pin_files=() candidates=()

  [[ -n "${LOONGSUITE_PILOT_CACHE_DIR:-}" ]] && pin_files+=("$LOONGSUITE_PILOT_CACHE_DIR/node-bin")
  [[ -n "${LOONGSUITE_PILOT_DATA_DIR:-}" ]] && pin_files+=("$LOONGSUITE_PILOT_DATA_DIR/node-bin")
  pin_files+=("$HOME/.loongsuite-pilot/node-bin")
  for pin_file in "${pin_files[@]}"; do
    candidate="$(pilot_read_node_pin "$pin_file" 2>/dev/null)" || continue
    printf '%s\n' "$candidate"
    return 0
  done

  # Prefer Pilot-managed runtimes, preserving the pin-file directory priority.
  for pin_file in "${pin_files[@]}"; do
    runtime_dir="$(dirname "$pin_file")/runtime"
    while IFS= read -r dir; do
      [[ -n "$dir" ]] && candidates+=("$dir/bin/node")
    done < <(for dir in "$runtime_dir"/node-v*; do
      [[ -d "$dir" ]] && printf '%s\n' "$dir"
    done | sort_version_dirs_desc)
  done
  while IFS= read -r dir; do
    [[ -n "$dir" ]] && candidates+=("$dir/bin/node")
  done < <(for dir in "$HOME/.nvm/versions/node"/*; do
    [[ -d "$dir" ]] && printf '%s\n' "$dir"
  done | sort_version_dirs_desc)
  candidates+=(
    "$HOME/.volta/bin/node"
    "$HOME/.fnm/aliases/default/bin/node"
    "$HOME/.local/share/fnm/aliases/default/bin/node"
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
