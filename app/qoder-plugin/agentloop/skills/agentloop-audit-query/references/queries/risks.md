# 风险概览与浏览配方

风险来自 incident-event；检测发现来自独立安全事实，二者不合并计数。接口覆盖用户目标窗口，SQL 中比较窗口另行明确。这里 `{{...}}` 为交付前展开的参数，不是 SDK 参数绑定能力。

## 概览与分布

`incident-record.v1` 按风险记录计数；与按风险对象去重的面板对账用 `incident-identity.v1`。正常 ID 唯一时二者相等；不为特殊回流默认改写所有查询。

```sql
* | SELECT count(*) AS risk_records,
  count_if(severity IN ('critical','high')) AS high_risk_records,
  1.0 * count_if(severity IN ('critical','high')) / nullif(count(*), 0) AS high_risk_ratio
FROM "incident-event"
WHERE risk_type IS NOT NULL AND risk_type <> '' AND risk_type <> '-'
```

分布：按 risk_type / risk_subtype 分组，`count(DISTINCT incident_event_id)` 为风险对象数；限定 critical/high 即高危分布。用户、应用、主机和会话影响面去除缺失占位，按身份与来源核对；多分组 distinct 不可相加。趋势使用同筛选的 Unix 秒桶，返回分子分母而非平均各桶比例。

## 日/周比较

对 [from,to) 分别生成当前、整体平移 86400 秒、整体平移 604800 秒的三个聚合查询，分别查询对应范围。可合并为条件聚合，但窗口重叠时一条事件可对多个窗口贡献，不能用互斥 CASE 分配给某一个周期。当前/前日/前周的时间桶平移后对齐，未完成或无权限不补零。

恶化最快风险按 risk_type + risk_subtype 聚合高危记录，保留 current_count、previous_day_count、previous_week_count；产品参考评分：

```text
day_delta = current_count - previous_day_count
week_delta = current_count - previous_week_count
day_rate = day_delta / max(previous_day_count, 10)
week_rate = week_delta / max(previous_week_count, 10)
score = ln(current_count + 1) * (
  max(day_delta, 0) * min(max(day_rate, 0), 3)
  + 0.5 * max(week_delta, 0) * min(max(week_rate, 0), 3))
```

只保留日或周增长 >0 的组，按 score、当前数量降序，再以类型/子类稳定排序。评分不是纯增长率；用户只要增长量排行时明确改名。产品单查询若采用互斥周期分配，长窗口重叠时需说明算法差异，不能声称对账相同。

影响面最大风险先以未展开实体的 incident 基表按类型/子类计算风险、应用、Agent、会话数量；用户/主机需从实体数组附着时另聚合，再 JOIN 同一组。按应用数、会话数、风险数降序与类型/子类稳定排序。不能在展开实体后 count(*) 当风险量。

## 风险浏览与分页

```sql
* | SELECT __time__ AS event_time, incident_event_id, source_scope,
  service_name, agent_type, "user" AS user_id, severity, confidence,
  risk_type, risk_subtype, data_exposure_surface, operation_stage,
  evidence_session_id
FROM "incident-event"
ORDER BY __time__ DESC, incident_event_id DESC LIMIT 0, 20
```

下一页使用同一查询、范围、筛选和 `LIMIT 20,20`，不用 `LIMIT ... OFFSET ...`。需要证据时按 ID 精确回捞 reason、evidence_values、entities 和 evidence_event_ids，仅展示必要且已脱敏部分。主/子类多选按配对 OR 条件拼接；子类原值不能脱离父类自动合并。

浏览摘要分别返回风险总数、高危对象数、影响 Session、风险类型数；Facet 对相同过滤范围分组，自身维度是否受当前已选值约束需明确，不擅自改成全库候选。

## 检测发现

`audit-event` 用 `event_domain='security'` 且排除 `intent.user_intent` / `intent.custom_user_intent`；普通意图同样不属于发现。历史 security-event 有公开契约且存在时可按一致列投影 UNION ALL，保留来源与各自 ID。

```sql
* | SELECT event_name, count(*) AS finding_records
FROM "audit-event"
WHERE event_domain = 'security'
  AND event_name NOT IN ('intent.user_intent','intent.custom_user_intent')
GROUP BY event_name ORDER BY finding_records DESC, event_name LIMIT 20
```

历史来源缺失就裁剪并披露覆盖；不得因风险表为空拿安全发现代替风险。“没有 incident”只说明当前观测未形成对应风险，不证明安全。
