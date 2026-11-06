---
description: 把 loongsuite-pilot 审计日志生成 HTML 报表或大盘预览。
---

# 生成报表

用户要报表、报告、大盘或 HTML 预览时使用。

按 [agentloop-audit-dashboard](../skills/agentloop-audit-dashboard/SKILL.md) 技能执行。产物默认放当前项目的 `output/audit/reports/`，用户指定目录时按其要求；从项目目录使用插件脚本绝对路径调用。复用已确认的查询范围和结果，按 Query Skill 的共享 schema、查询构件及本技能示例写 spec，再生成 dashboard JSON 并预览。时间范围未确认时先询问。以示例为参考生成本次报表文件。成功后给出可点击的 HTML 文件链接，并说明用浏览器打开。用户确认预览之前，不要发布到 SLS 或 AgentLoop。
