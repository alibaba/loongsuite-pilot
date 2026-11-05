# 拦截记录配方

口径 `guardrail-block.v1`。原始应用事件中的 `gen_ai.guardrail.triggered` 和 `gen_ai.guardrail.action` 分别表示触发及采取的动作。已拦截限定 triggered=true 且 action=block；不能从 error、脱敏标记或 incident 数量推断拦截。

## 两表汇总

```sql
* | WITH guardrail_events AS (
  SELECT __time__ AS ts, "event.id" AS event_id,
    "user.id" AS user_id, "gen_ai.agent.type" AS agent_type,
    "gen_ai.session.id" AS session_id,
    "gen_ai.guardrail.triggered" AS triggered, "gen_ai.guardrail.action" AS action
  FROM "agent-event" WHERE __time__ >= {{from}} AND __time__ < {{to}}
  UNION ALL
  SELECT __time__ AS ts, "event.id" AS event_id,
    "user.id" AS user_id, "gen_ai.agent.type" AS agent_type,
    "gen_ai.session.id" AS session_id,
    "gen_ai.guardrail.triggered" AS triggered, "gen_ai.guardrail.action" AS action
  FROM "agent-event-webtracking" WHERE __time__ >= {{from}} AND __time__ < {{to}}
)
SELECT count(*) AS triggered_events, count_if(action = 'block') AS blocked_events
FROM guardrail_events WHERE triggered = 'true'
```

同一 CTE 下加 action=block，按 Unix 秒桶分组为拦截趋势；按 agent_type/user_id 分组为筛选分布。应用、工具、主机等维度按 schema 明确投影到两侧，不能仅在一个来源补列。

记录列表选择事件时间、event_id、来源表、user_id、Session、Tool Call、Trace 等标识，按 ts、纳秒时间、event_id、来源稳定排序分页。可以跨表 UNION ALL 后统一 SQL 排序；若每表分别分页，则客户端全局归并，不能把两页简单拼接当一页。

回捞同一授权身份、应用和 Session 的会话上下文；guardrail 触发、拦截、后续操作执行结果是不同事实。缺失字段或无匹配记录时如实说明，不填充推测的拦截理由。
