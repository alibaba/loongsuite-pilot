"""Update exported Multica dashboards. Read/write JSON keyed by dashboardName via stdin/stdout.

By default the exported task-execution dashboard supplies the reference panels.
Pass --task-panels PATH to apply a separately maintained panel template first.
"""
import argparse
import json
import sys
import re
from pathlib import Path


def update(boards, templates=None):
    task_charts = {c["title"]: c for c in boards["multica-task-execution"]["charts"]}
    for name, template in (templates or {}).items():
        panel = task_charts[name]
        token_query = "\n".join(template["queryLines"])
        panel["search"]["chartQueries"][0].update(
            tokenQuery=token_query,
            query=re.sub(r"\$\{\{\w+\|([^}]*)\}\}", r"\1", token_query),
        )
        panel["display"].update(template["display"])
    for board, dashboard in boards.items():
        for chart in dashboard["charts"]:
            name = chart["title"]
            display = chart["display"]
            queries = chart.get("search", {}).get("chartQueries", [])
            if board == "multica-business-observability" and name in ("multica-claim", "multica-prom-durations"):
                model = task_charts[name]
                # The legacy dashboard uses the most recently observed deployment.
                query = model["search"]["chartQueries"][0]["query"]
                queries[0].update(query=query, tokenQuery=query)
                display["basicOptions"]["displayName"] = model["display"]["basicOptions"]["displayName"]
                display["documentLinkOption"] = model["display"]["documentLinkOption"]
                if chart["type"] == model["type"]:
                    display["queryOptionMap"] = model["display"]["queryOptionMap"]
            if name in ("product-retries", "multica-prom-attempts"):
                for q in queries:
                    field = display["queryOptionMap"][q["name"]]["showField"][0]
                    aggregate = {"平均尝试次数": "round(avg(attempts),2)",
                                 "额外重试次数": "sum(greatest(attempts-1,0))"}[field]
                    for key in ("query", "tokenQuery"):
                        prefix = task_charts["multica-claim"]["search"]["chartQueries"][0][
                            key if board != "multica-business-observability" else "query"
                        ].split(", samples AS (", 1)[0]
                        q[key] = prefix + """, per_task AS (
 SELECT workspace_id,task_id,max_by(try_cast(attempt AS bigint),observed_at_ms) AS attempts
 FROM deployment_log WHERE record_type='task_snapshot' AND nullif(task_id,'') IS NOT NULL
 GROUP BY workspace_id,task_id)
 SELECT """ + aggregate + ' AS "' + field + '" FROM per_task WHERE attempts>0'
                display["basicOptions"]["displayName"] = ("执行尝试与额外重试" if len(queries) > 1 else "平均执行尝试次数") + " · 已尝试任务快照"
                display["standardOption"]["noValue"] = "窗口内没有带尝试次数的已执行任务"
            messages = {
                "multica-claim-details": "当前实例没有领取决策明细，可在任务执行页查看已启动任务",
                "multica-prom-failures": "窗口内没有可计算的新增失败样本",
                "multica-log-evidence": "窗口内未采到匹配的事件日志",
                "multica-http-logs": "窗口内未采到 HTTP 请求日志",
                "multica-triggers": "窗口内没有自动化触发记录",
                "multica-quota": "窗口内没有自动化触发结果",
                "multica-quota-details": "窗口内没有自动化触发结果",
                "multica-autopilots": "窗口内没有自动任务配置记录",
                "multica-prom-autopilot": "窗口内没有可计算的自动化新增样本",
                "multica-queue": "窗口内没有匹配的等待记录",
            }
            if name in messages:
                display.setdefault("standardOption", {})["noValue"] = messages[name]
    return boards


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-panels", type=Path, help="Optional external panel template")
    args = parser.parse_args()
    templates = json.loads(args.task_panels.read_text(encoding="utf-8")) if args.task_panels else None
    json.dump(update(json.load(sys.stdin), templates), sys.stdout, ensure_ascii=False)
