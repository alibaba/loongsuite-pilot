#!/usr/bin/env bash
set -euo pipefail

# Cursor hook entrypoint — delegates to cursor-hook-processor.mjs.

if [[ "${1:-}" == "--system-scope" ]]; then
  export PATH='/usr/bin:/bin'
  unset CDPATH NODE_OPTIONS NODE_PATH
  umask 077
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROCESSOR="$SCRIPT_DIR/cursor-hook-processor.mjs"
EMPTY_RESULT='{}'
if [[ "${1:-}" != "--system-scope" ]]; then
  NODE_PIN_FILE="$HOME/.loongsuite-pilot/node-bin"
fi

log_error() {
  local stage="$1"
  local message="$2"
  local data_dir="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
  local day
  day="$(date -u +%Y-%m-%d 2>/dev/null || true)"
  [[ -n "$day" ]] || day="unknown"
  local dir="$data_dir/logs/cursor/errors"
  local file="$dir/cursor-error-$day.jsonl"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"time":"%s","clientType":"CursorHook","stage":"%s","error.type":"shell_%s","error.message":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
    "$stage" \
    "$stage" \
    "$(printf '%s' "$message" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""')" \
    >> "$file" 2>/dev/null || true
}

if [[ -t 0 ]]; then
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if [[ ! -f "$PROCESSOR" && "${1:-}" != "--system-scope" ]]; then
  echo "[loongsuite-pilot] hook processor not found: $PROCESSOR" >&2
  log_error "missing_processor" "hook processor not found: $PROCESSOR"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

MIN_NODE_MAJOR=18

node_is_suitable() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  local ver major
  if major="$(node_major_from_runtime_path "$bin")"; then
    (( major >= MIN_NODE_MAJOR )) || return 1
    return 0
  fi
  node_is_app_bundle "$bin" && return 1
  ver="$("$bin" --version 2>/dev/null)" || return 1
  major="${ver#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= MIN_NODE_MAJOR )) || return 1
  return 0
}

# Managed runtimes live at <pilot-dir>/runtime/node-v<x>.<y>.<z>/bin/node, extracted by the
# installer only after it verified SHASUMS256 and probed the binary itself, so the directory
# name is authoritative. Reading the major from the path skips a `node --version` boot that
# would otherwise run on the user's interactive path for every single event -- ~60ms on a
# quiet host, 200ms+ where EDR scans each exec. Anything that is not a managed runtime still
# gets probed.
node_major_from_runtime_path() {
  local bin="$1" dir name
  dir="${bin%/bin/node}"
  [[ "$dir" != "$bin" ]] || return 1
  name="${dir##*/}"
  [[ "${dir%/*}" == */runtime ]] || return 1
  case "$name" in node-v[0-9]*) ;; *) return 1 ;; esac
  name="${name#node-v}"
  name="${name%%.*}"
  [[ "$name" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$name"
}

node_is_app_bundle() {
  local resolved
  resolved="$(realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$resolved" in
    /Applications/*.app/Contents/*|/System/Applications/*.app/Contents/*|"${HOME:-}"/Applications/*.app/Contents/*)
      return 0
      ;;
  esac
  return 1
}

# Numeric-descending sort for version directory paths (stdin, one per line).
# Prefers sort -V; falls back to zero-padded keys where sort -V is unavailable
# (e.g. BSD/macOS sort, which has no -V).
sort_version_dirs_desc() {
  if printf '' | sort -V >/dev/null 2>&1; then
    sort -rV
    return
  fi
  local d v ma mi pa
  while IFS= read -r d; do
    v="${d##*/}"; v="${v#node-v}"; v="${v#v}"
    IFS=. read -r ma mi pa <<<"$v"
    [[ "$ma" =~ ^([0-9]+) ]] && ma="${BASH_REMATCH[1]}" || ma=0
    [[ "$mi" =~ ^([0-9]+) ]] && mi="${BASH_REMATCH[1]}" || mi=0
    [[ "$pa" =~ ^([0-9]+) ]] && pa="${BASH_REMATCH[1]}" || pa=0
    printf '%04d.%04d.%04d|%s\n' "$ma" "$mi" "$pa" "$d"
  done | sort -r | cut -d'|' -f2-
}

system_stat() {
  stat -c '%u %a' -- "$@" 2>/dev/null || stat -f '%u %Lp' "$@" 2>/dev/null
}

trusted_system_mode() {
  local owner="$1" mode="$2"
  [[ "$owner" == 0 || "$owner" == "$EUID" ]] && [[ "$mode" =~ ^[0-7]{1,4}$ ]]
}

trusted_system_directory() {
  local metadata owner mode
  [[ -d "$1" && ! -L "$1" ]] || return 1
  metadata="$(system_stat "$1")" || return 1
  read -r owner mode <<< "$metadata"
  trusted_system_mode "$owner" "$mode" || return 1
  (( (8#$mode & 022) == 0 || (${2:-0} == 1 && (8#$mode & 01000) != 0) ))
}

trusted_system_ancestors() {
  local dir="$1" sticky=0
  while true; do
    trusted_system_directory "$dir" "$sticky" || return 1
    [[ "$dir" == / ]] && return 0
    dir="${dir%/*}"
    dir="${dir:-/}"
    sticky=1
  done
}

trusted_system_files() {
  local file metadata owner mode
  for file in "$@"; do
    [[ -f "$file" && -r "$file" && ! -L "$file" ]] || return 1
  done
  metadata="$(system_stat "$@")" || return 1
  while read -r owner mode; do
    trusted_system_mode "$owner" "$mode" && (( (8#$mode & 022) == 0 )) || return 1
  done <<< "$metadata"
}

run_system_processor() {
  local data_dir="${SCRIPT_DIR%/*}" list="$SCRIPT_DIR/cursor-system-assets.list"
  local config_pin="$SCRIPT_DIR/cursor-system-config-path" config_file rel pinned resolved metadata owner mode
  local -a assets=()
  trusted_system_ancestors "$SCRIPT_DIR" || return 1
  trusted_system_directory "$SCRIPT_DIR/cursor" && trusted_system_directory "$SCRIPT_DIR/shared" || return 1
  [[ -s "$list" ]] && trusted_system_files "$list" "$data_dir/node-bin" || return 1
  while IFS= read -r rel; do
    [[ "$rel" =~ ^[a-zA-Z0-9._-]+(/[a-zA-Z0-9._-]+)?$ ]] || return 1
    case "/$rel/" in */../*|*/./*) return 1 ;; esac
    assets+=("$SCRIPT_DIR/$rel")
  done < "$list"
  trusted_system_files "$PROCESSOR" "${assets[@]}" || return 1

  pinned="$(cat "$data_dir/node-bin")" || return 1
  pinned="${pinned%$'\r'}"
  [[ "$pinned" == /* && "$pinned" != *$'\n'* && "$pinned" != *$'\r'* ]] || return 1
  resolved="$(realpath "$pinned" 2>/dev/null || readlink -f "$pinned" 2>/dev/null)" || return 1
  trusted_system_ancestors "$(dirname "$resolved")" || return 1
  trusted_system_files "$resolved" && node_is_suitable "$resolved" || return 1

  trusted_system_files "$config_pin" || return 1
  config_file="$(cat "$config_pin")" || return 1
  [[ "$config_file" == /* && "$config_file" != *$'\n'* && "$config_file" != *$'\r'* ]] || return 1
  trusted_system_ancestors "$(dirname "$config_file")" || return 1
  if [[ -e "$config_file" || -L "$config_file" ]]; then
    trusted_system_files "$config_file" || return 1
  fi
  if [[ -e "$data_dir/state" || -L "$data_dir/state" ]]; then
    trusted_system_directory "$data_dir/state" || return 1
  fi
  trusted_system_directory "$data_dir/logs" && trusted_system_directory "$data_dir/logs/cursor" || return 1
  metadata="$(system_stat "$data_dir/logs/cursor")" || return 1
  read -r owner mode <<< "$metadata"
  [[ "$owner" == "$EUID" ]] && (( (8#$mode & 077) == 0 )) || return 1
  export LOONGSUITE_PILOT_DATA_DIR="$data_dir"
  export AGENT_DATA_COLLECTION_CONFIG="$config_file"
  export LOONGSUITE_PILOT_CURSOR_SYSTEM_SCOPE=1
  "$resolved" "$PROCESSOR" >/dev/null
}

if [[ "${1:-}" == "--system-scope" ]]; then
  if ! run_system_processor; then
    echo "[loongsuite-pilot] Cursor system hook runtime unavailable or untrusted" >&2
  fi
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

NODE_BIN=""

# 1. Try pinned node
if [[ -f "$NODE_PIN_FILE" ]]; then
  pinned="$(tr -d '\r\n' < "$NODE_PIN_FILE" 2>/dev/null || true)"
  if [[ -n "$pinned" ]] && node_is_suitable "$pinned"; then
    NODE_BIN="$pinned"
  fi
fi

# 2. Fallback search (read-only — does NOT update pin)
if [[ -z "$NODE_BIN" ]]; then
  # Managed runtime node (never removed by user node-manager churn) comes first,
  # newest version first. Numeric-descending order matches the daemon's
  # compareNodeRuntimeDirs; a plain reverse glob is lexicographic and would
  # prefer node-v22.9.0 over node-v22.22.2.
  candidates=()
  runtime_dir="$(dirname "$NODE_PIN_FILE")/runtime"
  # Appends "<dir>/bin/node" for each newline-separated dir in $1, newest first.
  # Herestring rather than `done < <(...)`: agents inject this hook as a bare path,
  # so the interpreter is up to each runtime, and `sh <script>` bypasses the shebang.
  # macOS /bin/sh is bash in POSIX mode, which rejects process substitution but still
  # accepts <<<. A pipe would run candidates+= in a subshell and lose it.
  # The list arrives as an argument so a non-zero glob/pipeline status cannot leak
  # into `set -e`, and the empty case returns early because <<<"" still yields one
  # blank line.
  add_node_bin_candidates() {
    local list="$1" d
    [[ -n "$list" ]] || return 0
    while IFS= read -r d; do
      if [[ -n "$d" ]]; then candidates+=("$d/bin/node"); fi
    done <<<"$list"
  }
  add_node_bin_candidates "$(for d in "$runtime_dir"/node-v*; do [[ -d "$d" ]] && printf '%s\n' "$d"; done | sort_version_dirs_desc)"
  add_node_bin_candidates "$(for d in "$HOME/.nvm/versions/node"/*; do [[ -d "$d" ]] && printf '%s\n' "$d"; done | sort_version_dirs_desc)"
  candidates+=(
    "$HOME/.volta/bin/node"
    "$HOME/.fnm/aliases/default/bin/node"
    /opt/homebrew/bin/node
    /usr/local/bin/node
    "$HOME/.local/bin/node"
  )
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  for candidate in "${candidates[@]}"; do
    if node_is_suitable "$candidate"; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "[loongsuite-pilot] node >= $MIN_NODE_MAJOR not found" >&2
  log_error "missing_node" "node >= $MIN_NODE_MAJOR not found"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

run_processor() {
  if ! "$NODE_BIN" "$PROCESSOR"; then
    echo "[loongsuite-pilot] hook processor failed" >&2
    log_error "processor_failed" "hook processor exited with non-zero status"
    return 1
  fi
}

if ! run_processor; then
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0
