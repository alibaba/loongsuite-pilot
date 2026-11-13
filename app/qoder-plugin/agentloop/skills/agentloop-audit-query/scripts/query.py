#!/usr/bin/env python3
"""审计查询。由 scripts/run.py 的 audit 子命令调用。"""

import argparse
import json
import sys
import time
from pathlib import Path

SETUP_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "agentloop-collector-setup" / "scripts"
if str(SETUP_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SETUP_SCRIPTS_DIR))

from util.aliyun import get_logs, get_space, list_spaces
from util.config_record import (
    DEFAULT_LOGSTORE,
    append_history,
    fail,
    load_target,
    require_profile,
    save_target,
)

DEFAULT_LINE = 100


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="audit", add_help=False, allow_abbrev=False)
    parser.add_argument("--agent-space", dest="agent_space", default="")
    parser.add_argument("--region", default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--logstore", default="")
    parser.add_argument("--query", default="")
    parser.add_argument("--from", dest="time_from", default="")
    parser.add_argument("--to", dest="time_to", default="")
    parser.add_argument("--line", default="")
    parser.add_argument("--offset", default="")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--list-spaces", action="store_true")
    args = parser.parse_args(argv)
    return {
        "agent_space": args.agent_space,
        "region": args.region,
        "project": args.project,
        "logstore": args.logstore,
        "query": args.query,
        "from": args.time_from,
        "to": args.time_to,
        "line": args.line,
        "offset": args.offset,
        "list": args.list,
        "list_spaces": args.list_spaces,
    }


def merged_target(saved, values):
    """Only inherit fields within the same confirmed project and region."""
    saved_ready = saved.get("slsProject") and saved.get("slsLogstore") and saved.get("regionId")
    project_changed = values["project"] and values["project"] != saved.get("slsProject")
    region_changed = values["region"] and values["region"] != saved.get("regionId")
    if (not saved_ready or project_changed or region_changed) and not (
        values["project"] and values["region"] and values["logstore"]
    ):
        missing = ["--" + key for key in ("project", "region", "logstore") if not values[key]]
        fail(
            "Query target changed or incomplete. Missing explicit %s. "
            "Pass --project, --region, and --logstore together." % ", ".join(missing)
        )
    project = values["project"] or saved.get("slsProject") or ""
    logstore = values["logstore"] or saved.get("slsLogstore") or ""
    region_id = values["region"] or saved.get("regionId") or ""
    agent_space = "" if values["project"] else (saved.get("agentSpace") or "")
    return save_target(agent_space, region_id, project, logstore)


def resolve_context(profile, values):
    saved = load_target()
    if values["agent_space"]:
        if values["project"]:
            fail("Cannot combine --agent-space with --project. Choose one query target.")
        if not values["region"]:
            fail("Pass --region. Choosing an AgentSpace requires its region. Do not use a default region.")
        name = values["agent_space"]
        region = values["region"]
    else:
        if values["project"] or values["logstore"] or values["region"]:
            return merged_target(saved, values)
        saved_ready = saved.get("slsProject") and saved.get("slsLogstore") and saved.get("regionId")
        if saved_ready:
            return saved
        name = saved.get("agentSpace") or ""
        region = saved.get("regionId") or ""
    space = get_space(profile, name, region)
    if not space.get("slsProject") or not (space.get("regionId") or region):
        fail("AgentSpace is missing slsProject or regionId")
    return save_target(
        space.get("agentSpace") or name,
        space.get("regionId") or region,
        space.get("slsProject") or "",
        values["logstore"] or DEFAULT_LOGSTORE,
    )


def parse_bound(text, label):
    try:
        return int(text)
    except ValueError:
        fail("%s is not a number" % label)


def query_window(values):
    now = int(time.time())
    end = parse_bound(values["to"], "--to") if values["to"] else now
    start = parse_bound(values["from"], "--from") if values["from"] else end - 3600
    if start > end:
        fail("--from must not be later than --to")
    return start, end


def parse_page(values):
    line = DEFAULT_LINE
    offset = 0
    if values["line"]:
        line = parse_bound(values["line"], "--line")
    if values["offset"]:
        offset = parse_bound(values["offset"], "--offset")
    if line < 1:
        fail("--line must be greater than 0")
    if line > DEFAULT_LINE:
        fail("--line must not exceed %d" % DEFAULT_LINE)
    if offset < 0:
        fail("--offset must not be less than 0")
    return line, offset


def run(argv):
    values = parse_args(argv)
    profile = require_profile()
    if values["list_spaces"]:
        spaces, errors = list_spaces(profile, values["region"])
        for error in errors:
            if error:
                print(error, file=sys.stderr)
        print(json.dumps({
            "spaces": [
                {"agentSpace": str(item.get("agentSpace") or ""), "regionId": str(item.get("regionId") or "")}
                for item in spaces
            ],
        }, ensure_ascii=False, indent=2))
        return
    context = resolve_context(profile, values)
    if values["list"] and not values["query"]:
        print(json.dumps({"context": load_target()}, ensure_ascii=False, indent=2))
        return
    if not values["query"]:
        fail("Missing --query. Search example: * . Stats example: * | SELECT count(*)")
    start, end = query_window(values)
    line, offset = parse_page(values)
    data = get_logs(profile, context, values["query"], start, end, line, offset)
    append_history({
        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "query": values["query"],
        "from": start,
        "to": end,
        "slsProject": context.get("slsProject") or "",
        "slsLogstore": context.get("slsLogstore") or "",
        "regionId": context.get("regionId") or "",
    })
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    run(sys.argv[1:])
