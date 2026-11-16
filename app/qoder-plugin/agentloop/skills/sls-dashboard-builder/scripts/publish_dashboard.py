#!/usr/bin/env python3
"""把本地 dashboard JSON 发布到当前查询目标的 SLS Project。不带 --confirm 时只打印将要执行的操作。"""

import argparse
import json
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SETUP_SCRIPTS_DIR = SCRIPT_DIR.parents[1] / "agentloop-collector-setup" / "scripts"
if str(SETUP_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SETUP_SCRIPTS_DIR))

from util.aliyun import SLS_VERSION, aliyun
from util.config_record import DEFAULT_LOGSTORE, load_target, require_profile

PLACEHOLDER_PROJECTS = {"", "@", "agentloop-xxx", "example-project"}
PLACEHOLDER_LOGSTORES = {"", "@"}


def parse_args():
    p = argparse.ArgumentParser(description="Publish a dashboard JSON to SLS")
    p.add_argument("--dashboard", dest="dashboard_json", type=Path, required=True, help="dashboard JSON 路径")
    p.add_argument("--name", default="", help="线上大盘名，默认取 JSON 的 dashboardName")
    p.add_argument("--remark", default="", help="本次修改原因，写入 attribute.remark")
    p.add_argument("--confirm", action="store_true", help="用户已确认预览，真正创建或覆盖线上大盘")
    return p.parse_args()


def bind_targets(dashboard, project, logstore):
    for chart in dashboard.get("charts", []):
        for q in (chart.get("search") or {}).get("chartQueries") or []:
            if "query" not in q:
                continue
            if str(q.get("project") or "") in PLACEHOLDER_PROJECTS:
                q["project"] = project
            if str(q.get("logstore") or "") in PLACEHOLDER_LOGSTORES:
                q["logstore"] = logstore


def main():
    args = parse_args()
    if not args.dashboard_json.is_file():
        print("dashboard JSON not found: %s" % args.dashboard_json, file=sys.stderr)
        return 1
    dashboard = json.loads(args.dashboard_json.read_text(encoding="utf-8"))
    name = args.name or str(dashboard.get("dashboardName") or "")
    if not name:
        print("dashboardName is empty. Pass --name.", file=sys.stderr)
        return 1

    saved = load_target()
    project = saved.get("slsProject") or ""
    region = saved.get("regionId") or ""
    logstore = saved.get("slsLogstore") or DEFAULT_LOGSTORE
    if not project or not region:
        print("Query target is incomplete. slsProject and regionId are required.", file=sys.stderr)
        return 1
    bind_targets(dashboard, project, logstore)

    now_ms = str(int(time.time() * 1000))
    attribute = {k: str(v) for k, v in (dashboard.get("attribute") or {}).items()}
    attribute.update({"type": "grid", "update": now_ms, "version": now_ms})
    if args.remark:
        attribute["remark"] = args.remark
    body = {
        "dashboardName": name,
        "displayName": dashboard.get("displayName") or name,
        "description": dashboard.get("description") or "",
        "attribute": attribute,
        "charts": dashboard.get("charts", []),
    }

    profile = require_profile()
    _, err = aliyun(profile, region, [
        "sls", "GetDashboard", "--version", SLS_VERSION,
        "--project", project, "--dashboardName", name,
    ])
    if err and "DashboardNotExist" not in err:
        print("GetDashboard failed: %s" % err[:300], file=sys.stderr)
        return 1
    action = "create" if err else "update"

    print("action=%s" % action)
    print("project=%s" % project)
    print("region=%s" % region)
    print("dashboard=%s" % name)
    print("charts=%d" % len(body["charts"]))
    if not args.confirm:
        print("dry_run=true")
        if action == "update":
            print("note=online dashboard exists and would be overwritten")
        return 0

    payload = json.dumps(body, ensure_ascii=False)
    if action == "create":
        cmd = ["sls", "CreateDashboard", "--version", SLS_VERSION, "--project", project, "--body", payload]
    else:
        cmd = ["sls", "UpdateDashboard", "--version", SLS_VERSION, "--project", project,
               "--dashboardName", name, "--body", payload]
    _, err = aliyun(profile, region, cmd)
    if err:
        print("%s failed: %s" % (action, err[:300]), file=sys.stderr)
        return 1
    print("published=true")
    print("console_url=https://sls.console.aliyun.com/lognext/project/%s/dashboard/%s" % (project, name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
