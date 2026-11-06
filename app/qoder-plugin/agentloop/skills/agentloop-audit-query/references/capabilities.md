# 审计能力

先在这张表里选定一行，再查 [schema.md](../../agentloop-audit-dashboard/schema.md) 的对应 Source。每次 `audit` 都带上这一行的 `--logstore`。记录里的 logstore 会被这次传入的值改掉。能力查询结束后，若用户没有要求更换默认表，再执行一次 `audit --logstore agent-event --list`，把默认表改回应用事实。表不在 project 里时不要传 `--logstore`，直接说明没有这张表。

统计类默认最近 7 天，并显式传 `--from`、`--to`（Unix 秒）。这一窗口没有行时，改查最近 30 天并说明窗口。不要打印日志正文、密钥或用户原文。展示用中文，筛选和下钻用原始编码，对照 [value-labels.md](../../agentloop-audit-dashboard/value-labels.md)。

下面的条数来自 2026-11-05 对当前查询目标的核对，只说明当时有没有数据。回答用户时以当场查询为准。

## 选择 logstore

| 逻辑数据源 | logstore | 本空间核对 |
|---|---|---|
| 应用事实 `agent_events` | `agent-event` | 近 7 天有数据 |
| 应用事实的另一条写入链路 | `agent-event-webtracking` | 近 7 天 0 行，近 30 天有数据。合并时用 SQL `UNION ALL`，不要默认两张表都有数 |
| 意图 `intent_events` | `audit-event` | 与安全发现、Skill 事实共用这张表。意图必须限定 `event_name`，不能用整表 `count(*)` |
| 安全发现 | `audit-event` | `event_domain = 'security'`。不是意图，也不是 `incident-event` |
| 风险明细 `incident_events` | `incident-event` | 高保真风险。有行时再按严重性中文 CASE |
| 运行时 | `ebpf-event` | 表在。有行之后再按 schema 回捞，不要用它统计应用 Token |
| 组织花名册 `dept_roster` | 客户表，例如 `department` | 当前 project 没有这张表。不要做覆盖率、未使用员工、部门 Top |
| 轨迹 | `agent-trajectory`、`trajectory-feature-event` 等 | 有行，但 schema 没有字段契约。用户没点名就不要查；点名时只做 `count(*)`，不要猜字段 |

`security-event` 也在当前 project 里。低保真发现以当场 `count(*)` 为准。风险明细以 `incident-event` 为准，不要把 `security-event` 或 `audit-event` 里的 `security.*` 当成意图。

`audit-event` 和 `incident-event` 上，Agent 类型的列名是平铺的 `agent_type`，用户列是 `user`。不要写成 `"gen_ai.agent.type"` 或 `"user.id"`，这两列在这两张表上不存在，会报 `Column cannot be resolved`。应用事实 `agent-event` 才用带点的 `"gen_ai.agent.type"` 和 `"user.id"`。

## 应用事实：`--logstore agent-event`

近 7 天。模型响应同时匹配 `gen_ai.model.response` 和 `llm.response`。工具调用同时匹配 `gen_ai.tool.call` 和 `tool.call`。表里的语句执行时前面加上 `* |`。

| 功能 | 核对 | 查询 |
|---|---|---|
| 事件类型分布 | 有数据，最多的是 `tool.call` | `SELECT "event.name" AS event_name, count(*) AS events GROUP BY event_name ORDER BY events DESC LIMIT 20` |
| 活跃用户 | 按清洗后的 `user.id` 去重 | `SELECT approx_distinct(nullif(nullif("user.id", ''), 'null')) AS active_users` |
| 各 Agent 已观测 Token | 只统计模型响应；输入 Token 已含缓存 | 见 [plugin-usage.md](plugin-usage.md) 的示例 |
| 模型分布 | 响应模型优先 | `SELECT coalesce(nullif(nullif("gen_ai.response.model", ''), 'null'), nullif(nullif("gen_ai.request.model", ''), 'null'), 'unknown') AS model, count(*) AS events WHERE "event.name" IN ('gen_ai.model.response', 'llm.response') GROUP BY model ORDER BY events DESC LIMIT 20` |
| 供应商 | 空值显示 `unknown` | `SELECT coalesce(nullif(nullif("gen_ai.provider.name", ''), 'null'), 'unknown') AS provider, count(*) AS events WHERE "event.name" IN ('gen_ai.model.response', 'llm.response') GROUP BY provider ORDER BY events DESC LIMIT 20` |
| 工具调用 | 不算 `tool.result` | `SELECT coalesce(nullif(nullif("gen_ai.tool.name", ''), 'null'), 'unknown') AS tool_name, count(*) AS events WHERE "event.name" IN ('gen_ai.tool.call', 'tool.call') GROUP BY tool_name ORDER BY events DESC LIMIT 20` |
| Skill 显式覆盖 | 非空 `gen_ai.skill.name` 的调用次数，以及全部工具调用次数。路径推断不要当成已采集事实 | `SELECT count(*) AS tool_calls, count_if(nullif(nullif("gen_ai.skill.name", ''), 'null') IS NOT NULL) AS skill_named WHERE "event.name" IN ('gen_ai.tool.call', 'tool.call')` |
| 缓存有效样本 | 有效样本数和响应数分开给，不把缺失当 0 命中 | `SELECT count(*) AS responses, count_if(try_cast("gen_ai.usage.input_tokens" AS bigint) > 0 AND try_cast("gen_ai.usage.cache_read.input_tokens" AS bigint) >= 0 AND try_cast("gen_ai.usage.cache_read.input_tokens" AS bigint) <= try_cast("gen_ai.usage.input_tokens" AS bigint)) AS cache_valid WHERE "event.name" IN ('gen_ai.model.response', 'llm.response')` |
| 错误事件 | 有 `error.type` 或 `error.message` 的行 | `SELECT count(*) AS errors WHERE nullif(nullif("error.type", ''), 'null') IS NOT NULL OR nullif(nullif("error.message", ''), 'null') IS NOT NULL` |
| 按北京时间的日趋势 | 桶值是 Unix 秒 | `SELECT cast(floor((__time__ + 28800) / 86400) * 86400 - 28800 AS bigint) AS day_ts, count(*) AS events GROUP BY day_ts ORDER BY day_ts` |
| 筛选某一种 Agent | `__all__` 表示不筛；指定时两处一起换成原值，例如 `cursor` | 展开后再放进模型响应查询的 WHERE |
| 下钻到会话 | 沿用上一问的时间窗口和 Agent 原值。`qoder` 与 `qoder-cli`、`qoder-cn` 不是同一个值 | `SELECT approx_distinct("gen_ai.session.id") AS sessions WHERE "event.name" IN ('gen_ai.model.response', 'llm.response') AND "gen_ai.agent.type" = 'qoder'` |

筛选模板先写成下面这样，再展开成最终 `--query`。脚本不替换 `${{ }}`。

```sql
AND ('${{agent_type|__all__}}' = '__all__' OR "gen_ai.agent.type" = '${{agent_type|__all__}}')
```

两张应用表合并时，在 `agent-event` 上执行，近 7 天 webtracking 可能是 0：

```sql
* | WITH event_raw AS (
  SELECT count(*) AS events FROM "agent-event"
  UNION ALL
  SELECT count(*) AS events FROM "agent-event-webtracking"
) SELECT sum(events) AS events FROM event_raw
```

## 其他表

查询同样写成 `* |` 加上表里的 SELECT，并带上该行的 `--logstore`。

| 功能 | logstore | 查询 | 口径 |
|---|---|---|---|
| WebTracking 行数 | `agent-event-webtracking` | `SELECT count(*) AS events` | 先 7 天，为 0 再查 30 天 |
| 意图条数 | `audit-event` | `SELECT count(*) AS events WHERE event_name IN ('intent.user_intent', 'intent.custom_user_intent')` | 同表的 `security.*` 和 `skill.read` 不是意图 |
| 意图分类 | `audit-event` | `SELECT intent_category, count(*) AS events WHERE event_name IN ('intent.user_intent', 'intent.custom_user_intent') GROUP BY intent_category ORDER BY events DESC` | 展示用 value-labels 的中文，筛选仍用原值 |
| 安全发现分布 | `audit-event` | `SELECT event_name, count(*) AS events WHERE event_domain = 'security' GROUP BY event_name ORDER BY events DESC LIMIT 20` | 这是发现，不是高保真风险 |
| 四类发现落在哪些 Agent | `audit-event` | `SELECT agent_type, event_name, count(*) AS events WHERE event_domain = 'security' AND event_name IN ('security.sensitive_data_exposure', 'security.credential_access', 'security.system_discovery', 'security.outbound_action') GROUP BY agent_type, event_name ORDER BY events DESC LIMIT 20` | 用平铺列 `agent_type` |
| 意图子类 | `audit-event` | `SELECT intent_category, intent_subcategory, count(*) AS events WHERE event_name IN ('intent.user_intent', 'intent.custom_user_intent') GROUP BY intent_category, intent_subcategory ORDER BY events DESC` | 中文对照 value-labels。子类不能脱离大类相加 |
| 风险条数 | `incident-event` | `SELECT count(*) AS events` | 为 0 就说明没有高保真风险，不要用安全发现条数代替 |
| 风险严重性 | `incident-event` | `SELECT agent_type, CASE severity WHEN 'critical' THEN '严重' WHEN 'high' THEN '高危' WHEN 'medium' THEN '中危' WHEN 'low' THEN '低危' ELSE coalesce(severity, '未记录') END AS label, risk_type, confidence, coalesce(nullif(data_exposure_surface, ''), '未记录') AS surface, CASE WHEN operation_stage IS NULL OR operation_stage = '' THEN '未记录' ELSE operation_stage END AS stage, count(*) AS events GROUP BY agent_type, label, risk_type, confidence, surface, stage` | 没有行就不要编严重性。不要 SELECT `reason` 或 `entities` |
| 运行时条数 | `ebpf-event` | `SELECT count(*) AS events` | 有行之后再按 schema 回捞，不要用它统计应用 Token |
| 低保真安全事件 | `security-event` | `SELECT count(*) AS events` | 与 `audit-event` 的安全发现不是同一张表 |

## 报表

报表与大盘走 [agentloop-audit-dashboard](../../agentloop-audit-dashboard/SKILL.md)。上面这些查询可以原样写进 dashboard JSON 的 `chartQueries[].query`，每张图的 logstore 写在 `chartQueries[].logstore`。取数用同一个 CLI，不另接阿里云接口。发布线上大盘要等用户确认本地预览。
