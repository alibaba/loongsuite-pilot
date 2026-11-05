# Token 分析配方

## 两种用量口径

`response-usage.v1` 沿用原报表：读取 [application-base.sql](application-base.sql) 的 usage_events，仅模型响应，observed_tokens = 输入 + 输出；输入已含缓存。用 `sum(observed_tokens)` 做用户/模型/Agent 排名与趋势，保留用量缺失覆盖，不将缺失当真实 0。

`call-usage.v1` 用于内置调用视角：读取有任一用量字段的事件，按来源、用户、应用、Session、Turn、Step、Tool Call 和模型归并；每调用取最大输入/输出，total 取 `greatest(max(total_tokens), max(input_tokens)+max(output_tokens))`。请求/响应可能共同描述一次调用，这一归并不是针对特殊回流的事件去重。模型选择、缺失调用键回退及 application/runtime 来源范围必须与目标页面一致，否则不宣称严格对账。

| 构件 | 响应口径 | 调用口径 |
|---|---|---|
| 基础行 | usage_events，一条模型响应 | token_calls，一次归并调用 |
| 模型 | 响应优先、请求回退 | 内置视角请求优先、响应回退 |
| total | 输入 + 输出 | total 与输入输出之和取最大值 |
| 缓存 | 有效样本条件聚合 | 不能直接套归并 total 作缓存分母 |

调用口径的应用侧 CTE 在 [call-usage.sql](call-usage.sql)，输出 `token_call_t`。绑定整数时间参数后追加目标 SELECT；本文将该调用结果简称 token_calls。该构件在调用维度之外保留用户与应用身份，Session 键用 JSON 数组编码以避免分隔符碰撞。部分内置视图只按来源 + Session 归并；存在跨用户/应用的同名 Session 时本构件会分开统计，必须说明对账差异，不能为一致而混合无关身份。

执行调用聚合前先以同一范围运行该 CTE + `SELECT token_events, unkeyed_events FROM token_source_quality_t`。只有 unkeyed_events=0 才继续调用数/用量聚合。event.id 缺失时不能用秒级时间合成“稳定”ID；改用响应事件观测口径并披露限制，或请客户确认稳定调用键。缺失 Turn/Step/Call 使用原始 event_id 回退，表示未能跨事件配对，不伪造已配对调用。

维护与裁剪时遵循：源字段依 schema 扩充 `gen_ai.usage.total_tokens`，两表保持列顺序；缺失 Turn/Step/Call 键分别使用 `event-turn:` / `event-step:` / `event-call:` + 稳定 event_id，不能把所有空键归并为一个调用。按完整用户/应用身份、上述调用身份和 model 分组，保留 first_time/latest_time、用户、应用、Agent 和来源。runtime 独立适配；默认不把它默默加进应用报表。缺少稳定 ID 时需先确认回退规则，不能凭时间秒数合并无关事件。

## 总量、模型与用户排名

响应口径示例，按索引确认后使用：

```sql
SELECT user_id, sum(observed_tokens) AS total_tokens,
  sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
  count(*) AS model_responses,
  count_if(input_tokens IS NOT NULL AND output_tokens IS NOT NULL) AS complete_usage_responses
FROM usage_events WHERE user_id IS NOT NULL
GROUP BY user_id ORDER BY total_tokens DESC, user_id LIMIT 20
```

换 model / agent_type 为模型/Agent 分布。调用口径从 token_calls 聚合 total_tokens，输出命名为 calls，不能把 count(*) 称为响应数。连续趋势按时间桶；内置调用视角按 latest_time 归桶。最近 24h 以当前范围结束时间为锚点独立取窗口，不自动以系统现在为结束时间。

## Turn / Session 统计与分布

先按来源、用户、应用和 Session 聚合；Turn 再加 turn_id，Step 再加 step_id 和 model。空 Turn 不算真实 Turn 数，可单列“缺失 Turn”的用量；内置回退键的数量须标为归并组数。

在该预聚合结果上计算均值、分位数、固定桶、排行和长会话，不能对模型响应直接 avg 冒充平均 Session Token。分布阈值：

| 视角 | 桶边界 |
|---|---|
| 单 Turn Token | <1k、<5k、<10k、<50k、<100k、其他 |
| Session Token | <10k、<50k、<100k、<500k、<1M、其他 |
| 长对话 Turn 数 | ≤1、≤5、≤10、≤20、≤50、其他 |

平均趋势将完整目标窗口的 Turn/Session 用量预聚合，再按 latest_time 分桶；“每小时内 Session 用量均值”是另一口径，必须另命名。Session 时长只覆盖窗口内观测。P95 全量应对未 LIMIT 的 Session 聚合使用 `approx_percentile(session_tokens, 0.95)`；UI Top Session 样本估算需要复现相同样本再算，不能把两者对账。

集中度：在全部 Session 聚合上 `row_number() OVER (ORDER BY session_tokens DESC, <稳定身份键>)`，计算总 Session 数及总 Token，再按累计人数百分比分桶并累计贡献。TopN 只限制最终展示，不能截断分母；并列和小样本人群的边界需说明。

## 缓存

在 usage_events 上使用 schema 的 cache_valid：输入 >0、读取缓存 ≥0 且不超过输入。条件求和计算命中率，另给有效响应数、缺失/异常数和覆盖率；未声明支持缓存字段的模型不按零命中处理。

## 对账前检查

逐项核对时间/时区、来源、筛选、事件兼容名、模型优先级、调用归并键、TopN 与样本、完整性以及返回数值类型。内置调用算法与响应算法不一致时同时给出明确命名的结果；不能为凑数改写旧报表口径。
