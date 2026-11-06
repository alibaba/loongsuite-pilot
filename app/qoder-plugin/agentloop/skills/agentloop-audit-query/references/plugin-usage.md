# 在本插件里使用筛选、变量和下钻

选功能和 logstore 先读 [capabilities.md](capabilities.md)。筛选和下钻的完整规则在报表技能里，这里不再复制：

- [filters-and-variables.md](../../sls-dashboard-builder/references/filters-and-variables.md)：筛选放在原始搜索还是 SQL 变量，以及 `${{key|default}}`、`__all__`
- [drill-down-events.md](../../sls-dashboard-builder/references/drill-down-events.md)：从汇总进入一个对象时传什么、时间怎么继承；需要控制台链接时用其中的 AgentLoop URL 配方

那两份写的是大盘控件。在对话里查询时，读完后决定筛选位置，把变量展开后传给 `audit --query`，需要时再查一次。用户要报表时改用 [agentloop-audit-dashboard](../../agentloop-audit-dashboard/SKILL.md)：把展开后的语句写入 dashboard JSON 的 `query`，再执行 `scripts/run.py report`。没有用户对预览的确认，不要发布大盘。

## 什么时候读

| 用户要做的事 | 先读 |
|---|---|
| 按 `user.id`、`event.name`、`gen_ai.agent.type`、`gen_ai.session.id` 这类原始字段收窄 | filters-and-variables.md 的「选择机制与作用范围」和「原始字段过滤」 |
| 可选筛选、默认看全部、或条件要写进 SQL | 同文的「变量语法与查询模板」 |
| 先看汇总，再看某一个人、某一种 Agent、某一个会话或原始日志 | drill-down-events.md 的「定义交互契约」和「配置目标查询与筛选」 |
| 要在 AgentLoop 控制台打开对应大盘 | 同文的「AgentLoop 仪表盘间跳转」 |

展示用中文。筛选和下钻传原始编码，例如 Agent 类型传 `qoder`，不传「Qoder」。

## 写成 audit 命令

在插件根目录执行。脚本不替换 `${{key}}`。传给 `--query` 的必须是展开后的语句。

- 可选筛选用文档里的 `__all__`。未指定时展开成 `'__all__' = '__all__'`，指定某个值时两处一起换成该原值。空串不是「全部」。
- 统计类问题用户没说时间时，用最近 7 天，并显式传 `--from` 和 `--to`（Unix 秒）。不要依赖脚本默认的最近 1 小时。
- 下一次查询沿用上一次的 `--from`、`--to`，以及当时的 project、logstore、region。关联键用上一次结果里的原值列。
- 本示例只查默认的 `agent-event`。不要改去 `audit-event` 或 `incident-event`，除非用户明确要意图或风险，且目标里真有这张表。
- Token 只统计模型响应：`event.name` 为 `gen_ai.model.response` 或 `llm.response`。`input_tokens` 已包含缓存，不要再加缓存字段。总量是输入加输出。

## 示例：各 Agent 的已观测 Token

用户说「查询最近 7 天各 Agent 的 Token」时，变量是 `agent_type`，默认 `__all__`。模板是：

```sql
* | SELECT
  coalesce(nullif(nullif("gen_ai.agent.type", ''), 'null'), 'unknown') AS agent_type,
  count(*) AS events,
  sum(coalesce(try_cast("gen_ai.usage.input_tokens" AS bigint), 0) + coalesce(try_cast("gen_ai.usage.output_tokens" AS bigint), 0)) AS total_tokens
WHERE "event.name" IN ('gen_ai.model.response', 'llm.response')
  AND ('${{agent_type|__all__}}' = '__all__' OR "gen_ai.agent.type" = '${{agent_type|__all__}}')
GROUP BY agent_type
ORDER BY total_tokens DESC
LIMIT 20
```

展开成「全部」后执行。`--from` 是当前时间减 604800，`--to` 是当前时间：

```bash
python3 scripts/run.py audit --from <now-604800> --to <now> --query "<上面展开后的 SQL>"
```

Windows 用 `scripts/run.ps1 audit`，参数相同。

回答时列出 `agent_type`、`events`、`total_tokens`。这是已观测 Token，不是账单。

## 示例：下钻到一种 Agent 的会话

用户接着说「看其中 qoder 的会话」时，不要新开时间窗口。把上一节两处 `__all__` 换成 `qoder`，并改成按会话列出。`qoder` 必须是上一张结果里的 `agent_type` 原值；结果里没有这个值就告诉用户，不要猜别的类型。

```sql
* | SELECT
  "gen_ai.session.id" AS session_id,
  "user.id" AS user_id,
  count(*) AS events,
  sum(coalesce(try_cast("gen_ai.usage.input_tokens" AS bigint), 0) + coalesce(try_cast("gen_ai.usage.output_tokens" AS bigint), 0)) AS total_tokens
WHERE "event.name" IN ('gen_ai.model.response', 'llm.response')
  AND ('qoder' = '__all__' OR "gen_ai.agent.type" = 'qoder')
  AND "gen_ai.session.id" IS NOT NULL AND "gen_ai.session.id" != ''
GROUP BY session_id, user_id
ORDER BY total_tokens DESC
LIMIT 20
```

`--from` 和 `--to` 与上一节相同。再往下看某一个会话的原始日志时，用结果列 `session_id` 做搜索，例如 `gen_ai.session.id: "<session_id>"`，仍然沿用同一时间窗口。单次最多 100 条，这是样本不是全量。

用户明确要打开控制台时，才按 drill-down-events.md 的 AgentLoop URL 配方给链接。`region` 和 AgentSpace 用 `~/.loongsuite-pilot/audit/config-record.json` 里的 `regionId`、`agentSpace`。没有现成大盘名时不要编造 `dashboard-name`。
