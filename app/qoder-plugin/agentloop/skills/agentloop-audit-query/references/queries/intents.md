# 意图审计配方

来源 audit-event，`intent-labels.v1`。只读 `event_name IN ('intent.user_intent','intent.custom_user_intent')`；普通域为 user_intent，风险意图域为 security。对账产品默认检测器时追加已公开且目标使用的 detector_name，不能悄悄排除客户自定义检测器。

## 数量、趋势与分类

```sql
* | SELECT count(*) AS intent_records,
  count_if(event_domain = 'security') AS risky_intent_records,
  1.0 * count_if(event_domain = 'security') / nullif(count(*), 0) AS risky_ratio,
  sum(try_cast(usage_total_tokens AS double)) AS allocated_tokens
FROM "audit-event"
WHERE event_name IN ('intent.user_intent','intent.custom_user_intent')
```

趋势按 __time__ 的 Unix 秒桶和 event_domain 分组。普通分类使用 intent_category + intent_subcategory；风险意图使用 risk_type + risk_subtype，不能将风险意图的空普通分类归到普通“其他”。枚举查 [value-labels](../value-labels.md)，自定义分类保持 taxonomy 上下文。

用户分布按清洗 user 统计去重用户，Session 分布先按来源、用户、应用、evidence_session_id 和标签聚合，保留多标签不可相加说明。用户概览、最近活动和会话概览复用同一限定条件，再按用户或会话身份聚合，不查询整张审计表。

usage_total_tokens 是按意图分摊的 Session Token；只对该字段求和表示“意图分摊用量”，不能再次加完整 Session 用量。无此字段时使用关联方式并另命名。

## 意图 × 模型 × 平均 Session 用量

应用事实先按来源、用户、应用、Session、模型预聚合成一行，意图表先按来源、用户、应用、Session、分类/子类归一为标签集合，再关联。示意接口：

```sql
SELECT i.intent_category, i.intent_subcategory, u.model,
  count(*) AS matched_session_model_groups,
  avg(u.session_tokens) AS avg_labeled_session_model_tokens
FROM session_model_usage u
JOIN session_intent_labels i
  ON u.source_scope = i.source_scope AND u.user_id = i.user_id
  AND u.session_id = i.session_id
  AND (u.service_name = i.service_name OR (u.service_name IS NULL AND i.service_name IS NULL))
GROUP BY i.intent_category, i.intent_subcategory, u.model
```

这里只展示预聚合接口；交付时必须补齐两侧 CTE、时间条件和 `* |`，不能把示意尾部当可执行完整 SQL。应用名缺失时先核查 Session 归属的唯一性，不因缺失放宽为笛卡尔 JOIN。统计 unmatched 与 matched 的事实组数及覆盖，未匹配不算 0 Token。多标签 Session 进入多个意图组，跨意图不可相加；该均值不是 usage_total_tokens 的模型分摊。

风险意图明细按 audit_event_id 引用、按 evidence_session_id / evidence_event_id 下钻；它仍是意图识别结果，不等同 incident 已成立风险。
