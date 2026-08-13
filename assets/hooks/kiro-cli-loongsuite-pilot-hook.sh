#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Kiro CLI Hook Script — delegates to kiro-cli-hook-processor.mjs
# ============================================================================
# Usage (registered in ~/.kiro/agents/<pilot-agent>.json by pilot deploy):
#   kiro-cli-loongsuite-pilot-hook.sh <event>
#
#   event  camelCase hook trigger (userPromptSubmit / preToolUse /
#          postToolUse / stop). Kiro passes the event JSON via stdin.
#
# The deploy prepends the event name to the hook command:
#   command: "<PILOT_HOOKS>/kiro-cli-loongsuite-pilot-hook.sh postToolUse"
# so $1 carries the event; the processor dispatches by argv.
#
# Fail-open: any error prints "{}" and exits 0, never blocks the host agent.
# ============================================================================

EMPTY_RESULT='{}'

# stdin is a TTY → manual run, no payload; return fast.
[[ -t 0 ]] && { printf '%s\n' "$EMPTY_RESULT"; exit 0; }

EVENT="${1:-unknown}"

log_error() {
  local stage="$1"
  local message="$2"
  local data_dir="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
  local day
  day="$(date -u +%Y-%m-%d 2>/dev/null || true)"
  [[ -n "$day" ]] || day="unknown"
  local dir="$data_dir/logs/kiro-cli/errors"
  local file="$dir/kiro-cli-error-$day.jsonl"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"time":"%s","gen_ai.agent.type":"kiro-cli","stage":"%s","error.type":"shell_%s","error.message":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
    "$stage" \
    "$stage" \
    "$(printf '%s' "$message" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""')" \
    >> "$file" 2>/dev/null || true
}

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$HOOKS_DIR/kiro-cli-hook-processor.mjs"

[[ -f "$PROCESSOR" ]] || {
  log_error "missing_processor" "hook processor not found: $PROCESSOR"
  printf '%s\n' "$EMPTY_RESULT"; exit 0
}

MIN_NODE_MAJOR=18

node_is_app_bundle() {
  local resolved
  resolved="$(realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$resolved" in
    /Applications/*.app/Contents/*|/System/Applications/*.app/Contents/*|"$HOME"/Applications/*.app/Contents/*)
      return 0 ;;
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

NODE_PIN_FILE="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}/node-bin"
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

[[ -n "$NODE_BIN" ]] || {
  log_error "missing_node" "node >= $MIN_NODE_MAJOR not found"
  printf '%s\n' "$EMPTY_RESULT"; exit 0
}

# Hook stdin payload piped through to the processor.
if ! "$NODE_BIN" "$PROCESSOR" "$EVENT"; then
  log_error "processor_failed" "hook processor exited non-zero (event=$EVENT)"
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0
