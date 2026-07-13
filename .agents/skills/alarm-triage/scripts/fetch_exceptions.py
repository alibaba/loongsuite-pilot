#!/usr/bin/env python3
"""Fetch LoongSuite Pilot exception snapshot from SLS (exception_monitor semantics)."""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

PROJECT = "loongsuite-cn-shanghai-admin"
REGION = "cn-shanghai"
STATUS_LOGSTORE = "loongsuite_status"
ALARM_LOGSTORE = "loongsuite_alarm"
STATUS_TOPIC = "pilot_status"

AK = "concat(COALESCE(ip, ''), '|', COALESCE(cast(user_id as varchar), ''))"
SK = "concat(COALESCE(ip, ''), '|', COALESCE(hostname, ''), '|', COALESCE(user_id, ''))"
UID = "cast(user_id as varchar)"
TZ = timezone(timedelta(hours=8))

ALARM_LABELS = {
    "SERVICE_NOT_RUNNING_ALARM": "服务未运行",
    "UPDATER_NOT_RUNNING_ALARM": "守护掉线",
    "UPDATER_FAILURE_ALARM": "updater 失败",
    "DEGRADED_STARTUP_ALARM": "降级启动",
    "FLUSH_SEND_ALARM": "发送失败",
    "PROCESS_RESOURCE_ALARM": "资源告警",
    "INPUT_STOP_ALARM": "输入停止",
    "BROKEN_VERSION_POINTER_ALARM": "版本指针损坏",
    "INVALID_NODE_BIN_ALARM": "node 二进制无效",
}


def skill_root() -> Path:
    # scripts/ -> alarm-triage/
    return Path(__file__).resolve().parents[1]


def parse_window(window: str) -> tuple[int, int]:
    now = int(time.time())
    if window.endswith("s") and window.startswith("-"):
        seconds = int(window[1:-1])
        return now - seconds, now
    raise ValueError(f"unsupported window: {window}")


def query_sls(logstore: str, query: str, ts_from: int, ts_to: int) -> list[dict]:
    cmd = [
        "aliyun", "sls", "GetLogs",
        "--project", PROJECT,
        "--logstore", logstore,
        "--query", query,
        "--from", str(ts_from),
        "--to", str(ts_to),
        "--skip-secure-verify",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if r.returncode != 0:
        raise RuntimeError(f"GetLogs failed: {r.stderr.strip()[:400] or r.stdout.strip()[:400]}")
    data = json.loads(r.stdout) if r.stdout.strip() else []
    if isinstance(data, dict):
        # some CLI versions wrap
        data = data.get("logs") or data.get("Logs") or []
    if not isinstance(data, list):
        raise RuntimeError(f"unexpected GetLogs payload type: {type(data)}")
    return data


def latest_s(*pairs: str) -> str:
    cols = ", ".join(f"max_by({f}, __time__) {alias}" for f, alias in (p.split(" ") for p in pairs))
    return f"(SELECT {SK} AS ak, {cols} FROM log GROUP BY {SK})"


def build_queries() -> dict[str, tuple[str, str]]:
    """name -> (logstore, query)."""
    sp = f"__topic__: {STATUS_TOPIC} and project: * | "
    ap = "* | "
    return {
        "health_kpis": (
            STATUS_LOGSTORE,
            sp + (
                f'SELECT '
                f'sum(CASE WHEN upa=\'false\' THEN 1 ELSE 0 END) AS daemon_down, '
                f'sum(CASE WHEN cvv=\'false\' THEN 1 ELSE 0 END) AS version_invalid, '
                f'round(sum(CASE WHEN upa=\'true\' THEN 1 ELSE 0 END)*100.0/count(*),2) AS daemon_alive_pct, '
                f'round(sum(CASE WHEN t=\'nohup\' THEN 1 ELSE 0 END)*100.0/count(*),2) AS nohup_pct, '
                f'count(*) AS agent_total '
                f'FROM {latest_s("updater_pid_alive upa", "current_version_valid cvv", "init_type t")}'
            ),
        ),
        "alarm_by_type": (
            ALARM_LOGSTORE,
            ap + (
                f'SELECT alarm_type, '
                f'concat(\'L\', cast(arbitrary(alarm_level) as varchar)) AS level_sample, '
                f'approx_distinct({AK}) AS agent_count, '
                f'approx_distinct(user_id) AS user_count, '
                f'approx_distinct(CASE WHEN alarm_level=3 THEN {AK} END) AS l3_agent_count '
                f'GROUP BY alarm_type ORDER BY agent_count DESC'
            ),
        ),
        "alarm_type_level": (
            ALARM_LOGSTORE,
            ap + (
                f'SELECT alarm_type, '
                f'concat(\'L\', cast(alarm_level as varchar)) AS level, '
                f'approx_distinct({AK}) AS agent_count, '
                f'approx_distinct(user_id) AS user_count '
                f'GROUP BY alarm_type, alarm_level ORDER BY agent_count DESC'
            ),
        ),
        "top_users": (
            ALARM_LOGSTORE,
            ap + (
                f'SELECT {UID} AS user_id, approx_distinct({AK}) AS agent_count, '
                f'array_join(array_sort(array_agg(DISTINCT alarm_type)), \', \') AS alarm_types '
                f'FROM log WHERE user_id IS NOT NULL '
                f'GROUP BY {UID} ORDER BY agent_count DESC LIMIT 20'
            ),
        ),
        "top_agents": (
            ALARM_LOGSTORE,
            ap + (
                f'SELECT ip, {UID} AS user_id, arbitrary(ver) AS ver, '
                f'approx_distinct(alarm_type) AS type_count, '
                f'array_join(array_sort(array_agg(DISTINCT alarm_type)), \', \') AS alarm_types '
                f'GROUP BY ip, {UID} ORDER BY type_count DESC LIMIT 20'
            ),
        ),
        "recent_samples": (
            ALARM_LOGSTORE,
            ap + (
                f'SELECT from_unixtime(__time__) AS t, alarm_type, '
                f'concat(\'L\', cast(alarm_level as varchar)) AS level, '
                f'ip, {UID} AS user_id, ver, input_name, alarm_message '
                f'ORDER BY __time__ DESC LIMIT 50'
            ),
        ),
    }


def to_int(v, default: int = 0) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def candidates_from_alarm_types(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        alarm_type = str(row.get("alarm_type") or "").strip()
        if not alarm_type:
            continue
        agents = to_int(row.get("agent_count"))
        if agents <= 0:
            continue
        out.append({
            "fingerprint": f"pilot-exc:{alarm_type}",
            "alarm_type": alarm_type,
            "label": ALARM_LABELS.get(alarm_type, alarm_type),
            "agent_count": agents,
            "user_count": to_int(row.get("user_count")),
            "l3_agent_count": to_int(row.get("l3_agent_count")),
            "level_sample": row.get("level_sample") or "",
        })
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--window", default="-604800s", help="SLS relative window, e.g. -604800s")
    parser.add_argument("--out-dir", default="", help="override output dir")
    args = parser.parse_args()

    root = skill_root()
    day = datetime.now(TZ).strftime("%Y-%m-%d")
    out_dir = Path(args.out_dir) if args.out_dir else root / "data" / "runs" / day
    out_dir.mkdir(parents=True, exist_ok=True)

    ts_from, ts_to = parse_window(args.window)
    queries = build_queries()
    results: dict[str, object] = {}
    errors: dict[str, str] = {}

    for name, (logstore, query) in queries.items():
        try:
            results[name] = query_sls(logstore, query, ts_from, ts_to)
            print(f"ok {name}: {len(results[name])} rows")  # type: ignore[arg-type]
        except Exception as e:  # noqa: BLE001
            errors[name] = str(e)
            results[name] = []
            print(f"ERR {name}: {e}")

    alarm_rows = results.get("alarm_by_type") or []
    payload = {
        "fetched_at": datetime.now(TZ).isoformat(),
        "window": args.window,
        "from": ts_from,
        "to": ts_to,
        "project": PROJECT,
        "sources": {
            "status": {"logstore": STATUS_LOGSTORE, "topic": STATUS_TOPIC},
            "alarm": {"logstore": ALARM_LOGSTORE, "topic": "pilot_alarm"},
        },
        "results": results,
        "errors": errors,
        "candidates": candidates_from_alarm_types(alarm_rows if isinstance(alarm_rows, list) else []),
    }

    out = out_dir / "exceptions.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out} candidates={len(payload['candidates'])} errors={len(errors)}")
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
