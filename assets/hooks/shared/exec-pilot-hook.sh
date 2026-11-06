# Shared by the agent hook shells. Exec the collector binary instead of Node.
# The caller defines EMPTY_RESULT and, when it can, log_error.

exec_pilot_hook() {
  local agent="$1"
  shift || true
  local bin=""
  local data_dir="${LOONGSUITE_PILOT_DATA_DIR:-${HOME:-}/.loongsuite-pilot}"
  local cache_dir="${LOONGSUITE_PILOT_CACHE_DIR:-$data_dir}"
  if [[ -n "${LOONGSUITE_PILOT_BIN:-}" && -x "${LOONGSUITE_PILOT_BIN}" ]]; then
    bin="$LOONGSUITE_PILOT_BIN"
  fi
  if [[ -z "$bin" && -r "$cache_dir/current" ]]; then
    local name
    name="$(tr -d '[:space:]' <"$cache_dir/current" 2>/dev/null || true)"
    if [[ -n "$name" && -x "$cache_dir/versions/$name/bin/loongsuite-pilot" ]]; then
      bin="$cache_dir/versions/$name/bin/loongsuite-pilot"
    fi
  fi
  if [[ -z "$bin" && -x "$data_dir/bin/loongsuite-pilot" ]]; then
    bin="$data_dir/bin/loongsuite-pilot"
  fi
  if [[ -z "$bin" && -n "${HOME:-}" && -x "$HOME/.local/bin/loongsuite-pilot" ]]; then
    bin="$HOME/.local/bin/loongsuite-pilot"
  fi
  if [[ -z "$bin" ]] && command -v loongsuite-pilot >/dev/null 2>&1; then
    bin="$(command -v loongsuite-pilot)"
  fi
  if [[ -z "$bin" ]]; then
    echo "[loongsuite-pilot] collector binary not found" >&2
    if declare -F log_error >/dev/null 2>&1; then
      log_error "missing_binary" "loongsuite-pilot binary not found"
    fi
    printf '%s\n' "${EMPTY_RESULT:-{}}"
    exit 0
  fi
  # shellcheck disable=SC1091
  if ! "$bin" hook-process "$agent" "$@"; then
    echo "[loongsuite-pilot] hook processor failed (agent=$agent)" >&2
    if declare -F log_error >/dev/null 2>&1; then
      log_error "processor_failed" "hook-process $agent exited non-zero"
    fi
    printf '%s\n' "${EMPTY_RESULT:-{}}"
  fi
  exit 0
}
