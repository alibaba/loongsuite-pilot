# SQL 写作技巧

## JSON 数组展开

SLS 中 JSON 索引字段可能以 VARCHAR 返回，先解析再转数组：

```sql
CROSS JOIN UNNEST(
  try(CAST(json_parse(coalesce(nullif(entities, ''), '[]')) AS ARRAY(JSON)))
) AS t(entity)
```

TRY 失败返回 NULL；统计数据质量时将解析失败与空数组分开。

## JOIN 前预聚合

会话使用来源、用户、应用、Session 复合键。用量先聚合，再关联意图、风险或花名册，避免一对多关联放大总量。外表的字段映射、唯一归属与快照见 [schema](schema.md)。

## 时间窗口

SQL 内的时间条件与接口 from/to 使用同一组 Unix 秒参数。多周期比较用独立条件聚合；窗口重叠时不要用互斥 CASE 分配事件。

## SQL 分页

```sql
ORDER BY __time__ DESC, incident_event_id DESC LIMIT 20, 20
```

分析 SQL 使用 `LIMIT offset,count`；接口 line/offset 用于原始检索。检查 `meta.progress=Complete`，未完成结果不作为准确全量。

## 分组汇总

distinct、均值、比例和分位数在目标粒度重算；TopN 之前计算总量分母。花名册 LEFT JOIN 的事实筛选放在事实侧，保留零用量员工。

## 字段与参数

带点字段、带连字符表名使用双引号；字符串中的单引号加倍。COALESCE 不能引用不存在的列。`{{from}}` / `{{to}}` 是本文 SQL 模板的整数标记，交付前展开；仪表盘 `${{key}}` 的替换规则见 Builder 参考。
