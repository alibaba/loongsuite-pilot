#!/usr/bin/env python3
"""审计查询。由 scripts/run.py 的 audit 子命令调用。"""

import argparse
import json
import sys
import time

from util.aliyun import get_logs, get_space
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
    }


def merged_target(saved, values):
    """One passed field replaces that saved field. The other two stay."""
    project = values["project"] or saved.get("slsProject") or ""
    logstore = values["logstore"] or saved.get("slsLogstore") or ""
    region_id = values["region"] or saved.get("regionId") or ""
    missing = []
    if not project:
        missing.append("project")
    if not logstore:
        missing.append("logstore")
    if not region_id:
        missing.append("region")
    if missing:
        fail(
            "Query target is incomplete. Missing %s. project, logstore, and region are required."
            % ", ".join(missing)
        )
    return save_target(saved.get("agentSpace") or "", region_id, project, logstore)


def resolve_context(profile, values):
    saved = load_target()
    # A passed project, logstore, or region edits that field only.
    # Region together with --agent-space still selects the space below.
    if values["project"] or values["logstore"] or (values["region"] and not values["agent_space"]):
        return merged_target(saved, values)
    saved_ready = saved.get("slsProject") and saved.get("slsLogstore") and saved.get("regionId")
    # A named AgentSpace replaces the saved target and its region.
    if values["agent_space"] or not saved_ready:
        name = values["agent_space"] or saved.get("agentSpace") or ""
        region = values["region"] or ("" if values["agent_space"] else (saved.get("regionId") or ""))
        space = get_space(profile, name, region)
        if not space.get("slsProject") or not (space.get("regionId") or region):
            fail("AgentSpace is missing slsProject or regionId")
        resolved_region = space.get("regionId") or region
        return save_target(
            space.get("agentSpace") or name,
            resolved_region,
            space.get("slsProject") or "",
            DEFAULT_LOGSTORE,
        )
    return saved


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
