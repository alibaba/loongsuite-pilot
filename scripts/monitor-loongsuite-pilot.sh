#!/usr/bin/env bash
set -euo pipefail

INTERVAL_SECONDS="${INTERVAL_SECONDS:-5}"
DATA_DIR="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
PID_FILE="${LOONGSUITE_PILOT_PID_FILE:-$DATA_DIR/loongsuite-pilot.pid}"
OUT_DIR="${LOONGSUITE_PILOT_MONITOR_DIR:-$DATA_DIR/logs/process-monitor}"
PROCESS_PATTERN="${LOONGSUITE_PILOT_PROCESS_PATTERN:-collector-daemon.js|loongsuite-pilot.*run|loongsuite-pilot run}"
RETENTION_HOURS="${LOONGSUITE_PILOT_MONITOR_RETENTION_HOURS:-6}"
CLEANUP_INTERVAL_SECONDS="${LOONGSUITE_PILOT_MONITOR_CLEANUP_INTERVAL_SECONDS:-300}"
CSV_HEADER="timestamp,pid,ppid,command,cpu_percent,mem_percent,rss_kb,vsz_kb,elapsed,threads,open_files,inet_connections,tcp_established,tcp_listen,udp_connections"

usage() {
    echo "Usage: $0 [--interval seconds] [--out-dir path] [--pid pid] [--pattern regex]"
    echo ""
    echo "Environment overrides:"
    echo "  INTERVAL_SECONDS, LOONGSUITE_PILOT_DATA_DIR, LOONGSUITE_PILOT_PID_FILE,"
    echo "  LOONGSUITE_PILOT_MONITOR_DIR, LOONGSUITE_PILOT_PROCESS_PATTERN,"
    echo "  LOONGSUITE_PILOT_MONITOR_RETENTION_HOURS, LOONGSUITE_PILOT_MONITOR_CLEANUP_INTERVAL_SECONDS"
}

TARGET_PID=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --interval)
            INTERVAL_SECONDS="${2:?missing value for --interval}"
            shift 2
            ;;
        --out-dir)
            OUT_DIR="${2:?missing value for --out-dir}"
            shift 2
            ;;
        --pid)
            TARGET_PID="${2:?missing value for --pid}"
            shift 2
            ;;
        --pattern)
            PROCESS_PATTERN="${2:?missing value for --pattern}"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

mkdir -p "$OUT_DIR"

STATUS_LOG="$OUT_DIR/loongsuite-pilot-monitor.log"
LAST_CLEANUP_EPOCH=0

csv_file_for_now() {
    echo "$OUT_DIR/loongsuite-pilot-process-$(date +%Y-%m-%d-%H).csv"
}

ensure_csv_header() {
    local csv_file="$1"
    if [ ! -f "$csv_file" ]; then
        echo "$CSV_HEADER" > "$csv_file"
    fi
}

log_status() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$STATUS_LOG"
}

cleanup_old_csvs() {
    local now_epoch
    now_epoch="$(date +%s)"
    if [ $((now_epoch - LAST_CLEANUP_EPOCH)) -lt "$CLEANUP_INTERVAL_SECONDS" ]; then
        return
    fi
    LAST_CLEANUP_EPOCH="$now_epoch"

    if [ "$RETENTION_HOURS" -le 0 ]; then
        return
    fi

    local retention_minutes=$((RETENTION_HOURS * 60))
    find "$OUT_DIR" -type f -name 'loongsuite-pilot-process-*.csv' -mmin +"$retention_minutes" -print -exec rm -f {} \; 2>/dev/null | while IFS= read -r removed; do
        log_status "removed old process metrics csv: $removed"
    done
}

count_lsof_rows() {
    local pid="$1"
    shift

    if ! command -v lsof >/dev/null 2>&1; then
        echo 0
        return
    fi

    { lsof "$@" -p "$pid" 2>/dev/null || true; } | awk 'END { if (NR > 0) print NR - 1; else print 0 }'
}

count_threads() {
    local pid="$1"

    if [ -r "/proc/$pid/status" ]; then
        awk '/^Threads:/ { print $2; found = 1 } END { if (!found) print 0 }' "/proc/$pid/status"
        return
    fi

    { ps -M -p "$pid" 2>/dev/null || true; } | awk 'END { if (NR > 1) print NR - 1; else print 0 }'
}

discover_pids() {
    if [ -n "$TARGET_PID" ]; then
        if kill -0 "$TARGET_PID" 2>/dev/null; then
            echo "$TARGET_PID"
        fi
        return
    fi

    if [ -f "$PID_FILE" ]; then
        local pid
        pid="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$pid"
            return
        fi
    fi

    ps -axo pid=,command= | awk -v pattern="$PROCESS_PATTERN" '
        $0 ~ pattern &&
        $0 !~ /monitor-loongsuite-pilot\.sh/ &&
        $0 !~ /cursor-loongsuite-pilot-hook\.sh/ &&
        $0 !~ /awk -v pattern/ {
            print $1
        }
    '
}

quote_csv() {
    local value="${1//\"/\"\"}"
    printf '"%s"' "$value"
}

sample_pid() {
    local pid="$1"
    local timestamp
    timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    local csv_file
    csv_file="$(csv_file_for_now)"
    ensure_csv_header "$csv_file"

    local row
    row="$(ps -p "$pid" -o pid= -o ppid= -o %cpu= -o %mem= -o rss= -o vsz= -o etime= -o comm= 2>/dev/null || true)"
    if [ -z "$row" ]; then
        return
    fi

    local parsed
    parsed="$(awk '
        {
            pid=$1; ppid=$2; cpu=$3; mem=$4; rss=$5; vsz=$6; elapsed=$7;
            command="";
            for (i=8; i<=NF; i++) {
                command = command (i == 8 ? "" : " ") $i;
            }
            printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s", pid, ppid, cpu, mem, rss, vsz, elapsed, command;
        }
    ' <<< "$row")"

    local sampled_pid ppid cpu_percent mem_percent rss_kb vsz_kb elapsed command
    IFS=$'\t' read -r sampled_pid ppid cpu_percent mem_percent rss_kb vsz_kb elapsed command <<< "$parsed"

    local threads open_files inet_connections tcp_established tcp_listen udp_connections
    threads="$(count_threads "$pid")"
    open_files="$(count_lsof_rows "$pid")"
    inet_connections="$(count_lsof_rows "$pid" -Pan -i)"
    tcp_established="$(count_lsof_rows "$pid" -Pan -iTCP -sTCP:ESTABLISHED)"
    tcp_listen="$(count_lsof_rows "$pid" -Pan -iTCP -sTCP:LISTEN)"
    udp_connections="$(count_lsof_rows "$pid" -Pan -iUDP)"

    {
        printf '%s,%s,%s,' "$timestamp" "$sampled_pid" "$ppid"
        quote_csv "$command"
        printf ',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
            "$cpu_percent" "$mem_percent" "$rss_kb" "$vsz_kb" "$elapsed" \
            "$threads" "$open_files" "$inet_connections" "$tcp_established" "$tcp_listen" "$udp_connections"
    } >> "$csv_file"
}

log_status "started interval=${INTERVAL_SECONDS}s out_dir=$OUT_DIR pid_file=$PID_FILE pattern=$PROCESS_PATTERN retention_hours=$RETENTION_HOURS"
echo "Writing hourly samples to: $OUT_DIR/loongsuite-pilot-process-YYYY-MM-DD-HH.csv"
echo "Writing monitor status to: $STATUS_LOG"

while true; do
    pids="$(discover_pids | awk '!seen[$0]++')"

    if [ -z "$pids" ]; then
        log_status "no matching process found"
    else
        while IFS= read -r pid; do
            [ -z "$pid" ] && continue
            sample_pid "$pid"
        done <<< "$pids"
    fi

    cleanup_old_csvs
    sleep "$INTERVAL_SECONDS"
done
