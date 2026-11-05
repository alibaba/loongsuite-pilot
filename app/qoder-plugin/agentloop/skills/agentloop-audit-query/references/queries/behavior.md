# 行为分析配方

口径 `behavior-events.v1`。使用 [application-base.sql](application-base.sql) 的 event_base；查询完整形式为 `* |` + 该 CTE + 本文 SELECT。时间参数展开为 Unix 秒整数。默认应用范围；可用字段按索引裁剪，不引用不存在列。

## 汇总与趋势

```sql
SELECT
  count(DISTINCT nullif(nullif(agent_id, ''), 'null')) AS active_agents,
  count(DISTINCT agent_type) AS agent_types,
  count_if(event_name = 'gen_ai.model.request') AS model_requests,
  count_if(event_name = 'gen_ai.model.response') AS model_responses,
  count_if(event_name = 'gen_ai.tool.call') AS tool_calls,
  count_if(event_name = 'gen_ai.tool.result') AS tool_results,
  count_if(event_name IN ('gen_ai.model.request','gen_ai.model.response',
    'gen_ai.tool.call','gen_ai.tool.result')) AS total_behavior
FROM event_base
```

活跃 Agent 的实例键需与目标数据的 agent.id 稳定性一致；只有类型字段时返回“活跃 Agent 类型数”，不能伪装成实例数。会话数先 `GROUP BY source_scope, user_id, service_name, session_id`，再计组；缺少身份分量时明确覆盖，不仅按 session_id 去重。

趋势加 `cast(floor(ts / {{bucket_seconds}}) * {{bucket_seconds}} AS bigint) AS bucket_ts`，按该桶及可选 agent_type 分组；桶宽为正整数，保持当前与比较窗口一致。连续趋势不折叠日期。

## 行为构成与工具错误

```sql
SELECT tool_name, count(*) AS tool_calls,
  count_if(nullif(nullif(error_type, ''), 'null') IS NOT NULL
    OR nullif(nullif(error_message, ''), 'null') IS NOT NULL) AS call_error_events
FROM event_base WHERE event_name = 'gen_ai.tool.call'
GROUP BY tool_name ORDER BY tool_calls DESC, tool_name LIMIT 20
```

这段统计调用事件自带的错误标记。若错误只在工具结果中，先按用户/应用/Session/Tool Call ID 将结果预聚合成每调用一行，再关联调用；按调用失败分子 / 调用分母算错误率并列出可关联覆盖。不能直接以“错误结果行数 / 调用行数”冒充失败调用率。

模型构成按 model 分组；工具名称归一采用显式映射，例如 Bash/Shell/exec_command → exec、Read → read、Write → write、Edit/MultiEdit → edit、WebFetch → web_fetch。命令执行从对应工具调用识别；只有“调用了执行工具”时命名为调用次数，不能声称实际命令成功。网络目标、命令族与结果长度需要 schema 的 JSON 参数/结果字段，按确认工具结构提取；缺字段时说明该细分不可用。

文件操作、命令、网络与其他工具需定义互斥分类再构成总量；不能把重叠命令/外联检测次数当作行为总数。结果长度基于结果事件的可观测文本，标明字节或字符单位。

## Session 与 Turn 聚合

```sql
SELECT source_scope, user_id, service_name, session_id,
  min(ts) AS first_time, max(ts) AS latest_time,
  max(ts) - min(ts) AS observed_duration_seconds,
  count_if(event_name IN ('gen_ai.model.request','gen_ai.model.response',
    'gen_ai.tool.call','gen_ai.tool.result')) AS total_behavior,
  count_if(event_name = 'gen_ai.tool.call') AS tool_calls
FROM event_base WHERE session_id IS NOT NULL
GROUP BY source_scope, user_id, service_name, session_id
ORDER BY total_behavior DESC, latest_time DESC, session_id LIMIT 20
```

时长分桶：`<60`、`<300`、`<900`、`<1800`、`<3600`、其他（秒）。窗口内首尾时差不等于生命周期时长；单事件 Session 为 0 秒。

Turn 编辑动作先按会话身份 + 非空 turn_id 聚合工具调用。修改工具 write/edit/apply_patch 与命令工具 exec 的次数采用 0、1–2、3–5、6–10、11–20、20+ 分桶；这是活动量视角，不据此判断产出成功。

日内 24h 活跃度先按完整 Turn 身份去重，再按指定时区的小时统计。UTC+8 示例 `cast(floor((ts + 28800) / 3600) AS bigint) % 24`；跨多天合并同一小时应在标题说明。
