# 用户风险配方

来源 incident-event，`user-risk.v1`。默认身份字段视角按清洗后的平铺 `"user"` 聚合；缺失值单列“未记录”，不虚构人员。需要复现产品实体归一的用户清单时，先按 [实体配方](entities.md) 展开 type=user 的稳定实体 ID，再按 incident_event_id + 用户实体 ID 去重，不能将展示名当身份键，也不能把一个多用户风险只归给平铺 user。

## 用户排行与概览

```sql
* | SELECT "user" AS user_id,
  count(DISTINCT incident_event_id) AS risk_count,
  count(DISTINCT CASE WHEN severity IN ('critical','high') THEN incident_event_id END) AS high_risk_count,
  count(DISTINCT nullif(nullif(nullif(host, ''), 'null'), '-')) AS host_count,
  count(DISTINCT nullif(nullif(nullif(service_name, ''), 'null'), '-')) AS application_count,
  max(__time__) AS latest_time
FROM "incident-event"
WHERE "user" IS NOT NULL AND "user" <> '' AND "user" <> 'null' AND "user" <> '-'
GROUP BY "user"
ORDER BY high_risk_count DESC, risk_count DESC, latest_time DESC, user_id LIMIT 20
```

单用户概览在分组前追加已安全转义的 `"user" = '<原始用户值>'`。Session 先按 source_scope、用户、应用、evidence_session_id 聚合再计数，避免相同裸 Session 跨来源混合。主机/应用占位值按 schema 清洗，不计入实际影响面。

用户构成按 risk_type/risk_subtype 或 severity 分组，用户时段按同一筛选时间桶分组。高危占比的分子分母来自同一范围，空分母返回 NULL。具体风险使用 [风险浏览分页](risks.md) 并追加同一用户范围，返回对象标识与证据引用。

相关实体先锁定用户范围内的 incident，再按 [实体配方](entities.md) UNNEST，按稳定实体 ID、类型和 incident ID 去重后计关联风险数。总风险量仍从未展开的 incident 基表计算。
