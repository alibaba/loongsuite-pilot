set -euo pipefail
[[ "${LOONGSUITE_PILOT_DATA_DIR:-}" == "$LP_RUNTIME_DATA" &&
   "${LOONGSUITE_PILOT_CACHE_DIR:-}" == "$LP_RUNTIME_CACHE" &&
   "${AGENT_DATA_COLLECTION_CONFIG:-}" == "$LP_RUNTIME_CONFIG" ]] || {
  printf '%s\n' '[loongsuite-pilot] runtime environment belongs to another installation' >&2; exit 1;
}
# Container entrypoint can identify its own fixed cgroup before exec context exists.
if [[ -z "${LOONGSUITE_PILOT_CONTAINER_ID:-}" && -r /proc/self/cgroup ]] &&
   /usr/bin/grep -Fq -- "$LP_RUNTIME_ID" /proc/self/cgroup; then
  export LOONGSUITE_PILOT_CONTAINER_ID="$LP_RUNTIME_ID"
fi
if [[ "${LOONGSUITE_PILOT_CONTAINER_ID:-}" != "$LP_RUNTIME_ID" ]]; then
  if [[ -n "${LOONGSUITE_PILOT_CONTAINER_ID:-}" ]]; then
    printf '%s\n' '[loongsuite-pilot] another container runtime context was supplied' >&2
    exit 1
  fi
  [[ -f "$LP_RUNTIME_DOCKER" && -x "$LP_RUNTIME_DOCKER" ]] || exit 1

  expected="$LP_RUNTIME_ID|$LP_RUNTIME_IMAGE|true|host|host|host|host|$LP_RUNTIME_DATA"
  cwd_covered=false
  # NUL records retain spaces, quotes, Unicode and separator characters in mounts.
  # The final status record also preserves inspect failures across process substitution.
  {
    IFS= read -r -d '' observed || exit 1
    [[ "$observed" == "$expected" ]] || { printf '%s\n' '[loongsuite-pilot] container identity or installation binding mismatch' >&2; exit 1; }
    IFS= read -r -d '' mount_count || exit 1
    [[ "$mount_count" =~ ^[0-9]+$ && "$mount_count" -le 1024 ]] || exit 1
    for ((index=0; index<mount_count; index++)); do
      IFS= read -r -d '' kind || exit 1
      IFS= read -r -d '' source || exit 1
      IFS= read -r -d '' destination || exit 1
      if [[ "$kind" == bind && "$source" == "$destination" ]] &&
         [[ "$PWD" == "$destination" || "$PWD" == "$destination/"* || "$destination" == / ]]; then
        cwd_covered=true
      fi
    done
    IFS= read -r -d '' trailing || exit 1
    IFS= read -r -d '' probe_status || exit 1
    [[ "$probe_status" == LP_RUNTIME_INSPECT_OK ]] || exit 1
  } < <(
    if "$LP_RUNTIME_DOCKER" inspect --type container --format '{{printf "%s|%s|%t|%s|%s|%s|%s|%s\000" .Id .Config.Image .State.Running .HostConfig.PidMode .HostConfig.NetworkMode .HostConfig.UTSMode .HostConfig.CgroupnsMode (index .Config.Labels "loongsuite-pilot.data-dir")}}{{printf "%d\000" (len .Mounts)}}{{range .Mounts}}{{printf "%s\000%s\000%s\000" .Type .Source .Destination}}{{end}}' "$LP_RUNTIME_ID"; then
      printf '\0LP_RUNTIME_INSPECT_OK\0'
    else
      printf '\0LP_RUNTIME_INSPECT_FAILED\0'
    fi
  )
  if [[ "$cwd_covered" != true ]]; then
    printf '[loongsuite-pilot] cwd is not covered by a same-absolute-path bind mount: %s\n' "$PWD" >&2
    exit 1
  fi
  host_cwd_id="$(/usr/bin/stat -Lc '%d:%i' -- "$PWD")" || exit 1
  forwarded=()
  while IFS= read -r key; do
    case "$key" in
      LOONGSUITE_PILOT_HOST_CWD_ID|LOONGSUITE_PILOT_CONTAINER_ID|LOONGSUITE_PILOT_CONTAINER_CONTROL_HELD|LOONGSUITE_PILOT_RESOURCE_ROOT) continue ;;
      HOME|USERPROFILE|PATH|APPDATA|LOCALAPPDATA|XDG_*|LOONGSUITE_PILOT_*|AGENT_DATA_COLLECTION_CONFIG|CODEX_*|QODER_*|CURSOR_*|CLAUDE_*|COPILOT_*|GROK_*|KIRO_*|TRACEPARENT|TRACESTATE)
        forwarded+=(--env "$key") ;;
    esac
  done < <(compgen -e)
  exec "$LP_RUNTIME_DOCKER" exec -i --user "$LP_RUNTIME_UID:$LP_RUNTIME_GID" \
    --workdir "$PWD" "${forwarded[@]}" \
    --env LOONGSUITE_PILOT_HOST_CWD_ID="$host_cwd_id" \
    --env LOONGSUITE_PILOT_CONTAINER_ID="$LP_RUNTIME_ID" \
    "$LP_RUNTIME_ID" "$LP_RUNTIME_LAUNCHER" "$@"
fi
# A matching environment value alone is insufficient to enter container mode.
# --cgroupns=host makes this exact cgroup visible with --pid=host as well.
[[ -r /proc/self/cgroup ]] && /usr/bin/grep -Fq -- "$LP_RUNTIME_ID" /proc/self/cgroup || {
  printf '%s\n' '[loongsuite-pilot] runtime cgroup identity mismatch' >&2; exit 1;
}

if [[ -n "${LOONGSUITE_PILOT_HOST_CWD_ID:-}" ]]; then
  [[ "$(/usr/bin/stat -Lc '%d:%i' -- .)" == "$LOONGSUITE_PILOT_HOST_CWD_ID" ]] || {
    printf '[loongsuite-pilot] mounted cwd identity differs from host: %s\n' "$PWD" >&2; exit 1;
  }
  unset LOONGSUITE_PILOT_HOST_CWD_ID
fi
