# Datasources

不同 datasource 的 `chartQueries` 最小结构。

原则：
- 查询图表使用 `search.chartQueries` 数组
- 每个 query 至少包含 `name` 和 `datasource`
- 除 `builtin` 外，通常还需要 `project`, `logstore`, `query`, `tokenQuery`
- `agentloop-dataset` 不写 `logstore`，改为 `agentSpaceName`、`datasetName`、`regionId`

## 通用字段

```ts
interface ChartQuery {
  name: string           // 必填，查询标识，如 "A", "B"
  datasource: string     // 必填，数据源类型
  project: string        // 非 builtin 时必填。agentloop-dataset 填 AgentSpace 的 SLS Project
  logstore: string       // logstore / metricstore / metricsql 时必填。agentloop-dataset 不写
  query: string          // 非 builtin 时必填
  tokenQuery: string     // 非 builtin 时必填，无变量替换时与 query 相同
  displayName?: string
  region?: string        // SLS 数据源地域
  agentSpaceName?: string
  datasetName?: string
  regionId?: string      // agentloop-dataset 的地域字段名，不用 region
  legendFormat?: string
  limit?: number         // metricstore 查询数量限制
  interval?: string      // metricstore 查询间隔
  type?: string          // builtin 类型 或 storeview 标识
}
```

## 1. logstore

普通 SLS 日志查询：

```json
{
  "name": "A",
  "project": "my-project",
  "logstore": "my-logstore",
  "datasource": "logstore",
  "query": "* | select count(*) as pv",
  "tokenQuery": "* | select count(*) as pv"
}
```

`query` 和 `tokenQuery` 在无变量替换时相同。

### `tablepro + logstore` 推荐写法

如果目标是**日志样本表 / 错误明细表 / TopN 表**，优先使用 scan SQL，而不是只给裸过滤条件。

推荐结构：

```json
{
  "name": "A",
  "project": "my-project",
  "logstore": "my-logstore",
  "datasource": "logstore",
  "query": "__LEVEL__:ERROR | set session mode=scan; select date_format(__time__, '%Y-%m-%d %H:%i:%S') as time, __source__ as source, __topic__ as topic, __LEVEL__ as level, requestId, errorMessage, message order by __time__ desc limit all",
  "tokenQuery": "__LEVEL__:ERROR | set session mode=scan; select date_format(__time__, '%Y-%m-%d %H:%i:%S') as time, __source__ as source, __topic__ as topic, __LEVEL__ as level, requestId, errorMessage, message order by __time__ desc limit all"
}
```

实践建议：
- 优先写成 `过滤条件 | set session mode=scan; select ...`
- 优先显式列字段，不默认 `select *`
- 通用字段优先：`__time__`, `__source__`, `__topic__`, `__LEVEL__`
- 再按业务补充主键、请求 ID、错误信息、状态字段
- 对 schema-less 日志，某些字段缺失时返回空值是正常现象

## 2. metricstore

PromQL 查询：

```json
{
  "name": "A",
  "project": "my-project",
  "logstore": "my-metricstore",
  "datasource": "metricstore",
  "query": "avg(cpu_usage_total{})",
  "tokenQuery": "avg(cpu_usage_total{})",
  "legendFormat": "cpu_usage_total",
  "interval": "60s",
  "limit": 10000
}
```

实践建议：
- `metricstore` 默认补 `interval` 和 `limit`
- 如果图例需要稳定可控，优先写 `legendFormat`
- `displayName` 可保留，但对 `linepro` 图例命名更稳的是 `legendFormat`
- 对单查询 `linepro`，如果用户看到的是完整时序结果，不要误判成单值图

## 3. metricsql

SQL 方式查询 metrics：

```json
{
  "name": "A",
  "project": "my-project",
  "logstore": "my-metricstore",
  "datasource": "metricsql",
  "query": "* | select promql_query_range('avg(cpu_usage_total{})', '60s') from metrics limit 10000",
  "tokenQuery": "* | select promql_query_range('avg(cpu_usage_total{})', '60s') from metrics limit 10000"
}
```

## 4. builtin

演示数据 / 占位模板：

```json
{
  "name": "A",
  "datasource": "builtin",
  "type": "random_time_line"
}
```

常见 builtin 类型：`random_time_line`, `random_bar`, `china_district`

不需要 `project`, `logstore`, `query`。用户未提供真实数据源时可用 builtin 作为原型。

## 5. storeview 规则

storeview 不是独立的 datasource 值，而是在原始 datasource 基础上加 `"type": "storeview"`。

注意：SLS 控制台 UI 层会临时将 datasource 显示为 `logstore_storeview`、`metricstore_storeview`、`metricsql_storeview`，但保存到 JSON 时会还原为基础 datasource 并保留 `type: "storeview"` 标识。生成 JSON 时始终使用保存态格式：

### logstoreview

```json
{
  "name": "A",
  "project": "my-project",
  "logstore": "my-logstoreview",
  "datasource": "logstore",
  "type": "storeview",
  "query": "* | select count(*) as pv",
  "tokenQuery": "* | select count(*) as pv"
}
```

### metricstoreview

```json
{
  "name": "A",
  "project": "my-project",
  "logstore": "my-metricstoreview",
  "datasource": "metricstore",
  "type": "storeview",
  "query": "avg(cpu_usage_total{})",
  "tokenQuery": "avg(cpu_usage_total{})",
  "interval": "60s",
  "limit": 10000
}
```

### metricstoreviewsql

```json
{
  "name": "A",
  "project": "my-project",
  "logstore": "my-metricstoreview",
  "datasource": "metricsql",
  "type": "storeview",
  "query": "* | select promql_query_range('avg(cpu_usage_total{})', '60s') from metrics limit 10000",
  "tokenQuery": "* | select promql_query_range('avg(cpu_usage_total{})', '60s') from metrics limit 10000"
}
```

## 6. agentloop-dataset

AgentLoop Dataset。查询上不写 `logstore`。`project` 填该 AgentSpace 的 SLS Project。地域字段名是 `regionId`。

```json
{
  "name": "A",
  "datasource": "agentloop-dataset",
  "agentSpaceName": "my-agent-space",
  "datasetName": "my_dataset",
  "regionId": "cn-hangzhou",
  "project": "my-project",
  "query": "* | SELECT __time__ AS t, category, count(*) AS cnt FROM \"my_dataset\" GROUP BY t, category ORDER BY t LIMIT 100",
  "tokenQuery": "* | SELECT __time__ AS t, category, count(*) AS cnt FROM \"my_dataset\" GROUP BY t, category ORDER BY t LIMIT 100"
}
```

外层 `search.query` 与 `search.logstore` 保持 `@`，`dataSourceType` 为 `current`。无变量时 `query` 与 `tokenQuery` 相同。时间留在 `search.start` / `search.end`。`__time__` 是 Unix 秒；分桶用 `__time__` 或整数除法。

字段按 [Dataset 查询](../../agentloop-audit-query/references/execution.md) 先读 `schema`，再写 SQL。

图表类型、`display` 和 `queryOptionMap` 复用 [图表模板](chart-templates.md)：表格 `tablepro`，单序列折线 `linepro`，分组折线 `aggpro`。`display.version` 用模板里的 `"2"`。

## 实践建议

- 用户没给真实数据源 → 用 `builtin`
- 用户给了 AgentSpace 和 Dataset → 用 `agentloop-dataset`，查询不写 `logstore`
- 用户给了 project / logstore / query → 用 `logstore`
- 用户给了 PromQL → 判断用 `metricstore` 还是 `metricsql`
- 用户给了 PromQL 且只是直接展示趋势 → 默认 `metricstore`
- 只有确实需要 SQL 二次加工 `metric / labels / value / time` 时，才用 `metricsql`
- 不要把 `logstoreview` 等直接写成 datasource 字符串
- 需要日志样本 / TopN / 事件明细时，优先 `tablepro + logstore + scan SQL`
- 需要错误趋势 / 事件趋势时，优先 `linepro + logstore + 聚合 SQL`
- 筛选机制、变量语法及控件候选数据源配置见 [筛选器与变量替换](filters-and-variables.md)
