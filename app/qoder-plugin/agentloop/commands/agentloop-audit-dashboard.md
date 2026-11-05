---
description: 把 loongsuite-pilot 审计日志生成 HTML 报表或大盘预览。
---

# 生成报表

用户要报表、报告、大盘或 HTML 预览时使用。

按 [agentloop-audit-dashboard](../skills/agentloop-audit-dashboard/SKILL.md) 技能执行，在插件根目录执行。该技能已经完备：从这次对话推测用户要放的，用它的 schema 和示例里已有的能力写成 spec，再生成 dashboard JSON 并预览。不要在这里另写页面规则，也不要直接渲染 examples 里的文件。成功后给出可点击的 HTML 文件链接，并说明用浏览器打开。用户确认预览之前，不要发布到 SLS 或 AgentLoop。
