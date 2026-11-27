# SQL 写作技巧

## JSON 数组展开

SLS 中 JSON 索引字段可能以 VARCHAR 返回，先解析再转数组：

```sql
CROSS JOIN UNNEST(
  try(CAST(json_parse(coalesce(nullif(entities, ''), '[]')) AS ARRAY(JSON)))
) AS t(entity)
```

TRY 失败返回 NULL；统计数据质量时将解析失败与空数组分开。托管索引未提供工具参数的动态子字段时，读取已支持的完整 JSON 字段，再用 JSON 函数提取。

## JOIN 前预聚合

会话使用来源、用户、应用、Session 复合键。用量先聚合，再关联意图、风险或花名册，避免一对多关联放大总量。外表的字段映射、唯一归属与快照见 [schema](schema.md)。

## 时间窗口

查询框、CLI 和 SDK 使用同一组 Unix 秒参数绑定 SQL 时间条件与接口 from/to。

相对时间仪表盘复用公共 CTE 时，移除同一窗口内各事实表的 `__time__ >= {{from}} AND __time__ < {{to}}` 条件，由图表 `search.start/end` 和仪表盘时间选择器控制查询范围；例如 application-base.sql 中两张应用事实表、意图关联中的 audit-event 都使用当前图表窗口。不要把本次验证的整数时间保存为相对报表的固定条件；`{{from}}` / `{{to}}` 本身不会由发布脚本自动更新。参见 [SLS 时间范围](https://help.aliyun.com/zh/sls/quick-guide-to-query-and-analysis)。

固定历史报表可以保留绝对时间。同比、不同快照有效期等独立窗口需分别设计时间条件与扫描范围，并验证切换时间和再次刷新后的边界；不要机械删除。多周期比较用独立条件聚合，窗口重叠时不要用互斥 CASE 分配事件。

## SQL 分页

```sql
ORDER BY __time__ DESC, incident_event_id DESC LIMIT 20, 20
```

分析 SQL 不写 LIMIT 默认只返回 100 行；参考 SQL 的非 TopN 多行查询显式使用 `LIMIT 10000`。结果达到上限时，继续 SQL 分页或调整范围、桶宽，不能直接当作全量。分页保持相同时间与筛选，ORDER BY 覆盖全部分组键；事实明细还需稳定的唯一排序键。参见 [LIMIT 子句](https://help.aliyun.com/zh/sls/limit-clause)。

检查 `meta.progress=Complete` 与结果行数限制是两件事；Complete 表示本次 SQL 已完成，不表示返回了所有分组。分析 SQL 使用 `LIMIT offset,count`，接口 line/offset 仅用于原始检索；GetLogsV2 的 `meta.limited` 也需检查，但显式 LIMIT 返回满页时仍需判断是否还有结果。参见 [GetLogsV2](https://help.aliyun.com/zh/sls/developer-reference/api-sls-2020-12-30-getlogsv2)。

## 分组汇总

distinct、均值、比例和分位数在目标粒度重算；TopN 之前计算总量分母。花名册 LEFT JOIN 的事实筛选放在事实侧，保留零用量员工。

## 字段与参数

带点字段、带连字符表名使用双引号；字符串中的单引号加倍。COALESCE 不能引用不存在的列。`{{from}}` / `{{to}}` 是查询模板的整数标记；一次性查询交付前展开，仪表盘适配见“时间窗口”。仪表盘 `${{key}}` 的替换规则见 Builder 参考。

## Dataset

AgentLoop Dataset 的语句只用于查询，不用于其他操作。查询用单 Dataset `SELECT`，或只读 SearchExpr。已保存的 `* | SELECT ...` 也是只读 SELECT，按原文执行。

先读该 Dataset 的 `schema`。公共字段类型是 `text`、`long`、`double`、`json`。系统字段用 `id` 和 `__time__`，不要依赖内部序列字段。

`SELECT` 只查这一个 Dataset，显式列出字段和 `LIMIT`，不把用户输入直接拼进 SQL。不使用 JOIN、UNION、INTERSECT、EXCEPT 或子查询。不写 `LIMIT` 时，服务默认最多返回 1000 行。

```sql
SELECT id, __time__, question, answer, trace_id
FROM "<dataset-name>"
ORDER BY __time__ DESC
LIMIT 100
```

SearchExpr 支持比较、`AND` / `OR` / `NOT`、括号、`field:value`、`field:*` 和前缀匹配，例如 `question:"timeout" AND score >= 0.8`。这一侧不用 `IN`、`BETWEEN`、`LIKE`、`IS NULL`、任意函数或 JSON Filter DSL。

语义检索只在该字段的 schema 已启用 embedding 时使用。距离阈值用 `similarity(question, "<semantic-query>") < 0.3`，值越小通常越相近。Top-K 用 `topk(question, "<semantic-query>") <= 10`。按距离排序：

```sql
SELECT id, question, semantic_distance(question, "<semantic-query>", "l2") AS distance
FROM "<dataset-name>"
ORDER BY distance ASC
LIMIT 10
```
