# Keep the container control plane on its native, container-aware helper.
# The selected source package remains immutable and owns runtime version/ABI.
sync_installed_scripts_from_version() {
  local version_dir="$1"
  native_version_root "$version_dir" || return 1
  [[ "$LP_RUNTIME_HELPER" == /* && -f "$LP_RUNTIME_HELPER" &&
     -x "$LP_RUNTIME_HELPER" && ! -L "$LP_RUNTIME_HELPER" ]] || {
    printf '%s\n' '[loongsuite-pilot] pinned container control helper unavailable' >&2
    return 1
  }
  LP_SOURCE_DIR="$version_dir" LP_CACHE_DIR="$CACHE_DIR" LP_DATA_DIR="$DATA_DIR" \
    LP_CONFIG_PATH="$CONFIG_FILE" LP_BIN_DIR="${LOONGSUITE_PILOT_BIN%/*}" \
    "$LP_RUNTIME_HELPER" installer-helper sync-service --from-env
}

# Only this verified container context uses background role management.
# Host init-type and service registrations remain untouched.
LP_RUNTIME_STATE="/tmp/loongsuite-pilot-container-$LP_RUNTIME_ID-$LP_RUNTIME_UID"
if [[ -e "$LP_RUNTIME_STATE" ]]; then
  [[ -d "$LP_RUNTIME_STATE" && ! -L "$LP_RUNTIME_STATE" && -O "$LP_RUNTIME_STATE" ]] || exit 1
else
  (umask 077; mkdir "$LP_RUNTIME_STATE") || exit 1
fi
[[ "$(/usr/bin/stat -c '%a:%u' "$LP_RUNTIME_STATE")" == "700:$LP_RUNTIME_UID" ]] || exit 1
INIT_TYPE_FILE="$LP_RUNTIME_STATE/init-type"
[[ ! -L "$INIT_TYPE_FILE" && ( ! -e "$INIT_TYPE_FILE" || ( -f "$INIT_TYPE_FILE" && -O "$INIT_TYPE_FILE" ) ) ]] || exit 1
if [[ ! -f "$INIT_TYPE_FILE" || "$(<"$INIT_TYPE_FILE")" != nohup ]]; then
  (umask 077; printf '%s\n' nohup > "$INIT_TYPE_FILE")
fi
LOONGSUITE_PILOT_BIN="$LP_RUNTIME_LAUNCHER"
read_init_type() { printf '%s\n' nohup; }
detect_init_system() { printf '%s\n' none; }
autostart_install() { return 1; }
autostart_install_collector_only() { return 1; }
autostart_install_updater_only() { return 1; }
# Explicit stop is persistent across supervisor polls until explicit start.
autostart_remove() { (umask 077; : > "$LP_RUNTIME_STATE/stopped"); }
runtime_start_roles() {
  ensure_dirs
  cmd_start_collector
  if [[ "$LP_RUNTIME_START_UPDATER" == 1 ]]; then
    local updater
    updater=$(find_current_user_processes updater | head -n 1 || true)
    if [[ -z "$updater" ]]; then cmd_restart_updater; fi
  fi
}
cmd_start() { rm -f "$LP_RUNTIME_STATE/stopped"; runtime_start_roles; }
schedule_updater_restart() {
  [[ "$LP_RUNTIME_START_UPDATER" == 1 ]] || return 0
  # The delayed callback rechecks explicit-stop state after acquiring control.
  nohup /bin/bash -c 'sleep 10; exec "$0" container-restart-updater-if-enabled' "$LOONGSUITE_PILOT_BIN" >> "$UPDATER_LOG_FILE" 2>&1 &
}
if [[ "${1:-}" == container-supervise ]]; then
  runtime_shutdown() { trap - TERM INT; "$LOONGSUITE_PILOT_BIN" stop; exit 0; }
  trap runtime_shutdown TERM INT
  "$LOONGSUITE_PILOT_BIN" container-reconcile
  while :; do
    sleep 5 &
    wait "$!" || true
    "$LOONGSUITE_PILOT_BIN" container-reconcile
  done
  exit 0
fi
runtime_control_held=false
if [[ "${LOONGSUITE_PILOT_CONTAINER_CONTROL_HELD:-}" == "$LP_RUNTIME_ID" ]]; then
  runtime_control_held=true
fi
# Never inherit control ownership into collector/updater or delayed callbacks.
unset LOONGSUITE_PILOT_CONTAINER_CONTROL_HELD
case "${1:-status}" in
  start|stop|restart|start-collector|restart-collector|restart-updater|rollback|container-reconcile|container-restart-updater-if-enabled)
    if [[ "$runtime_control_held" != true ]]; then
      lock="$LP_RUNTIME_STATE/control.lock"
      [[ ! -L "$lock" && ( ! -e "$lock" || ( -f "$lock" && -O "$lock" ) ) ]] || exit 1
      set +e
      LOONGSUITE_PILOT_CONTAINER_CONTROL_HELD="$LP_RUNTIME_ID" \
        /usr/bin/flock --exclusive --timeout 5 --conflict-exit-code 75 --close "$lock" \
        "$LOONGSUITE_PILOT_BIN" "$@"
      result=$?
      set -e
      if [[ "$result" == 75 ]]; then
        case "${1:-}" in
          *updater*) write_restart_failure updater service-manager-refused 'container role control is busy' ;;
          *collector*) write_restart_failure collector service-manager-refused 'container role control is busy' ;;
        esac
      fi
      exit "$result"
    fi
    ;;
esac
case "${1:-}" in
  start-collector|restart-collector) rm -f "$LP_RUNTIME_STATE/stopped" ;;
esac
case "${1:-}" in
  container-reconcile)
    if [[ ! -f "$LP_RUNTIME_STATE/stopped" ]]; then
      if ! is_running; then cmd_start_collector; fi
      if [[ "$LP_RUNTIME_START_UPDATER" == 1 ]]; then
        updater=$(find_current_user_processes updater | head -n 1 || true)
        if [[ -z "$updater" ]]; then cmd_restart_updater; fi
      fi
    fi
    exit 0 ;;
  container-restart-updater-if-enabled)
    if [[ "$LP_RUNTIME_START_UPDATER" == 1 && ! -f "$LP_RUNTIME_STATE/stopped" ]]; then cmd_restart_updater; fi
    exit 0 ;;
esac
# Retain every original shell-dispatch command, including upgrade and rollback.
# Unknown/new native CLI commands go to ELF; unsupported uninstall/autostart stay errors.
case "${1:-status}" in
  installer-helper)
    [[ "$LP_RUNTIME_HELPER" == /* && -f "$LP_RUNTIME_HELPER" &&
       -x "$LP_RUNTIME_HELPER" && ! -L "$LP_RUNTIME_HELPER" ]] || {
      printf '%s\n' '[loongsuite-pilot] pinned container control helper unavailable' >&2
      exit 1
    }
    exec "$LP_RUNTIME_HELPER" "$@"
    ;;
  start|stop|restart|status|info|inject|hook|deploy|dashboard|token-usage|tokens|menubar|span-attr|worker|agent|upgrade|rollback|start-collector|restart-collector|schedule-updater-restart|restart-updater|run|run-updater|hook-process|probe|interceptor|help|--help|-h|log|diagnose-service) ;;
  *)
    pilot_bin=$(resolve_pilot_bin) || exit 1
    exec "$pilot_bin" "$@"
    ;;
esac
