#!/usr/bin/env python3
"""Ad-hoc SLS query for alarm-triage verification (same project/logstores as fetch)."""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path

PROJECT = "loongsuite-cn-shanghai-admin"
STATUS_LOGSTORE = "loongsuite_status"
ALARM_LOGSTORE = "loongsuite_alarm"
STATUS_TOPIC = "pilot_status"

# Agent key used by exception_monitor semantics
AK = "concat(COALESCE(ip, ''), '|', COALESCE(cast(user_id as varchar), ''))"
SK = "concat(COALESCE(ip, ''), '|', COALESCE(hostname, ''), '|', COALESCE(user_id, ''))"
UID = "cast(user_id as varchar)"


def parse_window(window: str) -> tuple[int, int]:
    now = int(time.time())
    if window.endswith("s") and window.startswith("-"):
        return now - int(window[1:-1]), now
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
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise SystemExit(f"GetLogs failed: {r.stderr.strip()[:500] or r.stdout.strip()[:500]}")
    data = json.loads(r.stdout) if r.stdout.strip() else []
    if isinstance(data, dict):
        data = data.get("logs") or data.get("Logs") or []
    if not isinstance(data, list):
        raise SystemExit(f"unexpected GetLogs payload type: {type(data)}")
    return data


def resolve_logstore(name: str) -> str:
    n = name.lower()
    if n in {"alarm", "loongsuite_alarm", ALARM_LOGSTORE}:
        return ALARM_LOGSTORE
    if n in {"status", "loongsuite_status", STATUS_LOGSTORE}:
        return STATUS_LOGSTORE
    return name


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--logstore", default="alarm", help="alarm|status|full logstore name")
    parser.add_argument("--query", required=True, help="SLS query (SQL after | allowed)")
    parser.add_argument("--window", default="-604800s")
    parser.add_argument("--out", default="", help="optional json output path")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    logstore = resolve_logstore(args.logstore)
    ts_from, ts_to = parse_window(args.window)
    rows = query_sls(logstore, args.query, ts_from, ts_to)
    text = json.dumps(rows, ensure_ascii=False, indent=2 if args.pretty else None)
    if args.out:
        path = Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        print(f"wrote {path} rows={len(rows)}")
    else:
        print(text)
    print(f"# rows={len(rows)} logstore={logstore} from={ts_from} to={ts_to}", flush=True)


if __name__ == "__main__":
    main()
