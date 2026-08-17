#!/usr/bin/env bash
set -euo pipefail

# Codex hook entrypoint — delegates to codex-hook-processor.mjs.
#
# Usage (registered in ~/.codex/hooks.json by pilot HookStrategy + trust hash 在 ~/.codex/config.toml):
#   $PILOT_DATA/hooks/codex-loongsuite-pilot-hook.sh <subcommand>
#
# Subcommand 与 Codex hook event 一一对应:
#   session-start / user-prompt-submit / subagent-start / subagent-stop / stop
#
# Fail-open 原则: 任何错误都输出 "{}" 并 exit 0,不阻塞宿主 agent。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$SCRIPT_DIR/codex-hook-processor.mjs"
PILOT_DATA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export LOONGSUITE_PILOT_DATA_DIR="${LOONGSUITE_PILOT_DATA_DIR:-$PILOT_DATA_DIR}"
EMPTY_RESULT='{}'
SUBCOMMAND="${1:-unknown}"

log_error() {
  local stage="$1"
  local message="$2"
  local data_dir="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
  local day
  day="$(date -u +%Y-%m-%d 2>/dev/null || true)"
  [[ -n "$day" ]] || day="unknown"
  local dir="$data_dir/logs/codex/errors"
  local file="$dir/codex-error-$day.jsonl"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"time":"%s","gen_ai.agent.type":"codex","stage":"%s","error.type":"shell_%s","error.message":%s}\n' \
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

if [[ ! -f "$PROCESSOR" ]]; then
  echo "[codex-hook] processor not found: $PROCESSOR" >&2
  log_error "missing_processor" "hook processor not found: $PROCESSOR"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

MIN_NODE_MAJOR=18

node_is_app_bundle() {
  local resolved
  resolved="$(realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$resolved" in
    /Applications/*.app/Contents/*|/System/Applications/*.app/Contents/*|"$HOME"/Applications/*.app/Contents/*)
      return 0
      ;;
  esac
  return 1
}

node_is_suitable() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  node_is_app_bundle "$bin" && return 1
  local ver
  ver="$("$bin" --version 2>/dev/null)" || return 1
  local major="${ver#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= MIN_NODE_MAJOR )) || return 1
  return 0
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

NODE_PIN_FILE="$LOONGSUITE_PILOT_DATA_DIR/node-bin"
NODE_BIN=""

if [[ -f "$NODE_PIN_FILE" ]]; then
  pinned="$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$pinned" ]] && node_is_suitable "$pinned"; then
    NODE_BIN="$pinned"
  fi
fi

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
  echo "[codex-hook] node >= $MIN_NODE_MAJOR not found" >&2
  log_error "missing_node" "node >= $MIN_NODE_MAJOR not found"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if ! "$NODE_BIN" "$PROCESSOR" "$SUBCOMMAND"; then
  echo "[codex-hook] processor failed (subcommand=$SUBCOMMAND)" >&2
  log_error "processor_failed" "hook processor exited non-zero (subcommand=$SUBCOMMAND)"
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0
