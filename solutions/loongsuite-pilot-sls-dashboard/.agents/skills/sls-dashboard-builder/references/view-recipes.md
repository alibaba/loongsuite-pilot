# View Recipes

This file maps task-level view intent to the SLS chart family and the minimum JSON details that matter.

## `compare-card` -> `statpro`

Use when the query returns one row with:
- a primary value such as `today`, `current_7d`, or `current_30d`
- a compare field such as `growth`
- optionally a previous value

Minimum important display fields:

```json
"queryOptionMap": {
  "A": {
    "showField": ["today"],
    "compareField": "growth",
    "compareThreshold": 0,
    "compareUnit": { "unit": "custom", "customUnit": "%" },
    "compareValueDescription": "较昨日变化"
  }
}
```

Rules:
- Do not use the bare `statpro` template for compare cards
- Counts usually want `standardOption.format = "KMB"`
- Rates usually want a custom `%` unit
- Cost usually wants a custom currency unit

## `line` -> `linepro`

Use when the query returns `time + one or more value columns`, for example:
- `t, active_accounts`
- `m, ai_native_share`

Minimum important display fields:

```json
"queryOptionMap": {
  "A": {
    "name": "A",
    "xAxisKey": "t",
    "yAxisKeys": ["active_accounts"]
  }
}
```

Good fit:
- DAU / WAU / MAU trends
- share-rate trends
- churn-rate trends

### When To Use `ts_compare(...)`

If the chart should compare aligned historical windows on the same timeline, prefer `ts_compare(...)` inside the query instead of creating separate manual series.

Good fit:
- `当前 / 1周前 / 5周前`
- `当月 / 1月前`
- aligned trend comparisons where each point needs its historical peer

Example shape:

```sql
* | SELECT
  t,
  diff[1] AS "当前",
  diff[2] AS "1周前",
  diff[3] AS "5周前"
FROM (
  SELECT
    t,
    ts_compare(active_accounts, 604800, 3024000) AS diff
  FROM (
    SELECT date_trunc('day', __time__) AS t,
           COUNT(DISTINCT ownerId) AS active_accounts
    FROM log
    GROUP BY t
  )
  GROUP BY t
  ORDER BY t
)
```

## Grouped Time Trend -> `aggpro`

Use when the query returns `time + group + value`, for example:
- `t, business_type, session_count`
- `t, business_type, total_tokens`

Minimum important display fields:

```json
"queryOptionMap": {
  "A": {
    "name": "A",
    "xAxisKey": "t",
    "aggField": "business_type",
    "yAxisKey": "session_count"
  }
}
```

Use `aggpro` instead of forcing these into `linepro`.

### Stream / Depth Distribution

For time + category depth + value distributions, `aggpro` with `chartType: "area"` usually works better than `linepro`.

Good fit:
- `天 × 场景数 × 用户数`
- `天 × 分层 × 用户数`
- depth or composition views where the stacking relationship matters

Important display fields:

```json
"aggChartOption": { "chartType": "area" },
"queryOptionMap": {
  "A": {
    "name": "A",
    "xAxisKey": "t",
    "aggField": "场景深度",
    "yAxisKey": "用户数"
  }
}
```

## `top-table` -> `tablepro`

Use for:
- Top customers
- Top workspaces
- Top business categories
- ranked drilldown tables

Rules:
- Prefer explicit `SELECT` columns
- Keep sort order explicit in SQL
- Basic tables usually do not need `queryOptionMap`

### Compare Table

If the user needs one table to show current value plus multiple relative comparisons, use `tablepro` with `compare(...)` in SQL instead of multiple single-window tables.

Good fit:
- segment comparisons like GC / customer / workspace
- columns such as `当前值`, `较1天前`, `较7天前`, `较30天前`

Example shape:

```sql
* | SELECT
  gc AS "GC",
  round(diff[1], 0) AS "日活账号数",
  round((diff[5]-1)*100, 2) AS "较1天前（%）",
  round((diff[6]-1)*100, 2) AS "较7天前（%）",
  round((diff[7]-1)*100, 2) AS "较30天前（%）"
FROM (
  SELECT gc, compare(active_accounts, 86400, 604800, 2592000) AS diff
  FROM (...)
  GROUP BY gc
)
```

## `cohort-table` -> `tablepro`

Use when the query returns columns like:
- `cohort_week` or `cohort_month`
- `cohort_users`
- `retained_users`
- `retention_rate`

Do not force a heatmap unless the task explicitly asks for a more opinionated visual layer.

## `markdownpro` For Scope Notes

Use for:
- blocked metrics
- data-quality caveats
- price or denominator assumptions

Keep notes short. One dashboard should not turn into a text document.

## `documentLinkOption` For Metric Definition

Use `documentLinkOption` when a chart needs a short, precise definition but does not need a full note card.

Good fit:
- threshold definitions such as `使用超过3种场景`
- churn or retention rules
- scene taxonomy caveats
- explanation of compare columns

Example:

```json
"documentLinkOption": {
  "documentLinks": [
    { "title": "口径：单月使用类别数>=3定义为深度使用用户；异常类别不纳入计数" }
  ],
  "showIcon": true
}
```

## Chinese Operator Labels

For operator-facing or business-facing dashboards, SQL aliases should already be the final Chinese labels.

Do this:
- `count(*) as "全部活跃用户数"`
- `count_if(req_count > 5) as "请求数>5次用户数"`
- `concat(cast(scene_count as varchar), '个场景') as "场景深度"`

Do not do this:
- `count(*) as active_users`
- `count_if(req_count > 5) as gt_5_users`
- `cast(scene_count as varchar) as scene_count`

The SQL alias usually becomes the legend, axis field, or table column. If the alias is poor, the dashboard UI will be poor.

## `droplistpro` For Real Filters

Use only when the dashboard can truly respond to the filter.

Common live pattern:

```json
"dropListOption": {
  "key": "ownerId",
  "type": "filter",
  "autoFilter": true,
  "globalFilter": false,
  "logic": "and"
}
```

Typical value-source query:

```json
{
  "name": "A",
  "datasource": "logstore",
  "project": "my-project",
  "logstore": "my-logstore",
  "query": "",
  "tokenQuery": "* | select distinct ownerId"
}
```

Do not add `droplistpro` just because the screenshot has filters. It must bind to a real key or token path.
