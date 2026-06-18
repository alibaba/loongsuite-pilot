# Query Syntax

`chartQueries[].query` / `chartQueries[].tokenQuery` 的构造规则。

本文档负责查询字符串的写法；`datasources.md` 负责 `chartQueries` 的 JSON 结构。两者互补，不重复定义。

## 快速决策：选哪种 datasource

| 场景 | datasource | query 写法 |
| --- | --- | --- |
| 日志聚合（趋势、TopN、KPI） | `logstore` | 搜索条件 `\|` SQL |
| 日志明细 / 样本表 | `logstore` | 搜索条件 `\|` `set session mode=scan; SELECT ...` |
| 日志扫描 + SPL 管道 | `logstore` | 搜索条件 `\|` SPL 命令链 |
| PromQL 时序查询 | `metricstore` | PromQL 表达式 |
| SQL 嵌套 PromQL | `metricsql` | `* \| SELECT promql_query_range(..., '60s') FROM metrics` |
| MetricStore SQL 直查 | `metricsql` | `* \| SELECT ... FROM "{store}.prom"` |

经验规则：
- `metricstore + PromQL` 在 SLS dashboard 里经常直接返回 `time / value / labels / metric` 序列，这类结果默认更适合 `linepro`
- 不要因为业务上想看“当前值”就先入为主做成 `statpro`；先看实际返回 shape
- `metricsql` 只有在确实需要 SQL 二次加工时再用，不要为了跑 PromQL 多套一层 SQL
- 如果出现嵌套 SQL 报错，优先回退到 `datasource: "metricstore"` + 直接 PromQL

## 1. logstore 查询写法

### 1.1 基本结构

```
搜索条件 | 分析语句
```

- `|` 左侧：搜索条件（过滤日志），依赖索引
- `|` 右侧：分析语句（SQL 或 scan SQL 或 SPL）
- 只有搜索条件时可省略 `|`
- 只有分析语句时，搜索条件写 `*`

### 1.2 搜索语法

#### 全文搜索

```
error                          # 包含 error
error timeout                  # 多个关键词默认 AND
error and timeout              # 同时包含（显式写法）
error or timeout               # 包含其一
error not debug                # 包含 error 但不含 debug
#"connection refused"          # 短语查询，精确匹配词序
```

#### 字段搜索

```
status:200                     # text 字段精确匹配
status>400                     # 数值字段比较（需 long/double 索引）
status>=400 and status<500     # 数值范围
status in [200 301 302]        # 枚举匹配（in 必须小写）
host:www.example.*             # 通配符（不能放开头）
field                          # 字段存在查询（更推荐）
field:*                        # 字段存在查询（兼容写法）
__source__:10.0.0.1            # 特殊保留字段
__topic__:access_log
__tag__:env:prod
```

#### 操作符优先级

`:` > `""` > `()` > `and` / `not` > `or`

建议：复合条件始终用括号明确优先级。

#### 注意事项

- 布尔运算符 `and`/`or`/`not` 必须小写
- 多个关键词之间不写运算符时默认 `and`
- 含空格、冒号、连字符的值需双引号：`message:"connection refused"`
- 精确短语匹配使用 `#"..."`，普通双引号只是转义
- 通配符 `*`/`?` 不能放在词首
- `__source__` 可缩写为 `source`，但如果业务字段也有 `source`，优先用 `__source__` 避免冲突
- 数值比较（`>`/`<`/`>=`/`<=`）仅对 long/double 索引字段有效，text 字段只能用 `:` 匹配
- `in` 运算符必须小写
- 字段存在查询如果只是判断“字段出现过”，可直接写 `field`，不必机械写成 `field:*`

### 1.3 索引分析（SQL）

搜索条件后接标准 SQL：

```sql
* | SELECT status, count(*) as pv GROUP BY status ORDER BY pv DESC LIMIT 10
```

#### 常用聚合函数

| 函数 | 说明 |
| --- | --- |
| `count(*)` | 计数 |
| `sum(field)` | 求和 |
| `avg(field)` | 平均值 |
| `min(field)` / `max(field)` | 最值 |
| `approx_distinct(field)` | 去重计数（近似） |
| `count_if(condition)` | 条件计数 |

#### 时间分桶

趋势图最常用的模式：

```sql
* | SELECT __time__ - __time__ % 60 as time, count(*) as pv
    GROUP BY time ORDER BY time LIMIT 10000
```

- `% 60` → 1 分钟粒度
- `% 300` → 5 分钟粒度
- `% 3600` → 1 小时粒度

#### 时间函数

| 函数 | 说明 | 示例 |
| --- | --- | --- |
| `date_format(ts, fmt)` | 时间戳格式化 | `date_format(__time__, '%Y-%m-%d %H:%i:%S')` |
| `date_trunc(unit, ts)` | 时间截断 | `date_trunc('minute', __time__)` |
| `from_unixtime(ts)` | Unix 时间戳转日期 | `from_unixtime(__time__)` |
| `to_unixtime(date)` | 日期转 Unix 时间戳 | `to_unixtime(now())` |
| `now()` | 当前时间 | |
| `date_diff(unit, ts1, ts2)` | 时间差 | `date_diff('second', start_time, end_time)` |

#### 字符串函数

| 函数 | 说明 |
| --- | --- |
| `split_part(str, delim, idx)` | 按分隔符取第 N 段 |
| `concat(a, b, ...)` | 拼接 |
| `substr(str, start, len)` | 子串 |
| `regexp_extract(str, pattern, group)` | 正则提取 |
| `regexp_like(str, pattern)` | 正则匹配 |
| `replace(str, old, new)` | 替换 |
| `length(str)` | 长度 |
| `lower(str)` / `upper(str)` | 大小写转换 |

#### 对比函数

同比/环比常用：

```sql
* | SELECT compare(pv, 86400) as diff
    FROM (SELECT count(*) as pv)
-- diff[1]: 当前值, diff[2]: 对比值, diff[3]: 变化比例
```

#### IP 函数

地图类图表常用：

| 函数 | 说明 |
| --- | --- |
| `ip_to_province(ip)` | IP → 省份 |
| `ip_to_city(ip)` | IP → 城市 |
| `ip_to_country(ip)` | IP → 国家 |
| `ip_to_geo(ip)` | IP → 经纬度 |
| `geohash(geo)` | 经纬度 → geohash |

### 1.4 扫描分析（Scan SQL）

用于日志明细表、样本表、TopN 等不依赖索引的场景：

```sql
__LEVEL__:ERROR | set session mode=scan;
SELECT date_format(__time__, '%Y-%m-%d %H:%i:%S') as time,
       __source__ as source, __LEVEL__ as level,
       requestId, errorMessage
ORDER BY __time__ DESC LIMIT ALL
```

#### 与索引分析的区别

- `|` 前的搜索条件仍依赖索引，应把有索引的过滤条件放在 `|` 前面
- `set session mode=scan;` 紧跟在 `|` 后面，然后接 SQL
- 优先显式 `SELECT` 字段，不用 `SELECT *`
- 适合 schema-less 日志的明细查询
- 对排障类趋势图，如果搜索条件依赖稀疏结构化字段、字段存在性判断、warning/error 组合过滤，也优先考虑 scan SQL

#### 限制

- 单 Shard 最多扫描 50 万行
- 总扫描上限 1000 万行
- 不支持随机分页，只能顺序翻页

### 1.5 扫描查询（SPL）

SPL 管道式处理，适合无索引字段的过滤和解析：

```
* | where cast(status as bigint) > 400 | project __time__, status, message
```

#### 常用 SPL 命令

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `where` | 过滤 | `where regexp_like(message, 'error\|timeout')` |
| `extend` | 新增计算字段 | `extend duration = cast(end_time as bigint) - cast(start_time as bigint)` |
| `project` | 保留指定字段 | `project time, status, message` |
| `project-away` | 移除指定字段 | `project-away __raw__` |
| `project-rename` | 重命名字段 | `project-rename new_name=old_name` |
| `parse-json` | 展开 JSON | `parse-json content` |
| `parse-regexp` | 正则提取多字段 | `parse-regexp message, '(\d+)\s(\w+)' as code, method` |

#### 注意事项

- SPL 中所有字段视为 text 类型，数值比较需 `cast`
- SPL 中字符串常量使用单引号；字段名含特殊字符时用双引号
- 顺序分页，不支持随机翻页
- 扫描上限 100K 行，超时 45 秒

## 2. metricstore 查询写法

`datasource: "metricstore"` 时，`query` 字段直接写 PromQL 表达式。

### 2.1 PromQL 基础

#### 即时查询

```promql
cpu_usage_total{cluster="prod", instance=~"web-.*"}
```

#### Label Matcher

| 操作符 | 说明 |
| --- | --- |
| `=` | 精确匹配 |
| `!=` | 不等于 |
| `=~` | 正则匹配 |
| `!~` | 正则不匹配 |

#### 聚合

```promql
sum by (cluster) (rate(http_requests_total[5m]))
avg by (instance) (cpu_usage_total{cluster="prod"})
topk(10, http_requests_total)
```

常用聚合操作符：`sum`, `avg`, `max`, `min`, `count`, `topk`, `bottomk`, `quantile`

分组语法：`sum by (label1, label2) (expr)` 或 `sum without (label) (expr)`

#### 常用函数

| 函数 | 说明 | 示例 |
| --- | --- | --- |
| `rate(v[d])` | 每秒平均增长率 | `rate(http_requests_total[5m])` |
| `irate(v[d])` | 瞬时增长率 | `irate(http_requests_total[5m])` |
| `increase(v[d])` | 时间段内增量 | `increase(http_requests_total[1h])` |
| `histogram_quantile(q, v)` | 分位数 | `histogram_quantile(0.99, rate(http_duration_bucket[5m]))` |
| `abs(v)` | 绝对值 | |
| `ceil(v)` / `floor(v)` | 取整 | |
| `round(v, to)` | 四舍五入 | |

#### 算术运算

PromQL 支持 `+`, `-`, `*`, `/` 在时序之间或时序与标量之间运算。

### 2.2 chartQueries 联动字段

`metricstore` 查询通常还需要：

```json
{
  "datasource": "metricstore",
  "query": "avg(cpu_usage_total{})",
  "tokenQuery": "avg(cpu_usage_total{})",
  "legendFormat": "cpu_usage_total",
  "interval": "60s",
  "limit": 10000
}
```

- `interval` — 查询步长，影响数据点密度
- `limit` — 返回时间点数量上限
- `legendFormat` — 线图图例名，优先用于稳定控制图例展示

### 2.3 图例与图表类型建议

- `linepro + metricstore`：
  - 优先在每个 `chartQueries[]` 上写 `legendFormat`
  - `displayName` 可以保留，但不要只依赖 `fieldOptions` 改图例
- 单查询 PromQL 如果返回的是 `time/value` 序列：
  - 小总览图优先 `linepro`
  - 只有用户明确要求数字卡片，且确认图表端能正确按最后一个点取值时，才考虑 `statpro`

## 3. metricsql 查询写法

`datasource: "metricsql"` 时，`query` 字段写 SQL，内嵌 PromQL 函数。

### 3.1 SQL + PromQL 混合查询

```sql
* | SELECT time, labels, value
    FROM (
        SELECT promql_query_range('avg by (instance) (cpu_usage_total{})', '60s')
        FROM metrics
    ) LIMIT 10000
```

#### 核心函数

| 函数 | 说明 | 参数 |
| --- | --- | --- |
| `promql_query('expr')` | 即时查询 | PromQL 表达式 |
| `promql_query_range('expr', 'step')` | 范围查询 | PromQL 表达式, 步长如 `'60s'` |

- `FROM` 子句固定为 `metrics`
- 返回字段：`metric`, `labels`, `time`, `value`
- 最多返回 11,000 个时间点
- `promql_query_range` 必须显式传入第二个 `step` 参数
- 如果外层还要再包 SQL，最内层也必须显式 `FROM metrics`，否则容易触发 nested sql 报错

#### 返回字段操作

```sql
* | SELECT time,
         element_at(labels, 'instance') as instance,
         value
    FROM (
        SELECT promql_query_range('cpu_usage_total{}', '60s') FROM metrics
    ) LIMIT 10000
```

- `labels` 是 map 类型，用 `element_at(labels, 'key')` 取值
- 可用 `concat()` 拼接多个 label 做自定义图例

### 3.2 MetricStore SQL 直查

不经过 PromQL 函数，直接 SQL 查询时序表：

```sql
* | SELECT __name__, element_at(__labels__, 'instance') as instance,
         __time_nano__ / 1000000000 as time, __value__
    FROM "{metricstore_name}.prom"
    WHERE __name__ = 'cpu_usage_total'
    LIMIT 10000
```

保留列：

| 列名 | 说明 |
| --- | --- |
| `__name__` | 指标名 |
| `__labels__` | 标签 map |
| `__value__` | 指标值 |
| `__time_nano__` | 纳秒时间戳 |

注意：表名两端的双引号必须保留。

## 4. Dashboard 常用查询模式速查

### KPI / 数字卡片（statpro）

```sql
* | SELECT count(*) as total_requests
```

```sql
* | SELECT compare(pv, 86400) as diff
    FROM (SELECT count(*) as pv)
```

### 趋势图（linepro）

```sql
* | SELECT __time__ - __time__ % 300 as time,
         count(*) as pv, approx_distinct(remote_addr) as uv
    GROUP BY time ORDER BY time LIMIT 10000
```

### 柱状图（barpro）

```sql
* | SELECT request_method, count(*) as pv, approx_distinct(remote_addr) as uv
    GROUP BY request_method ORDER BY pv DESC LIMIT 20
```

### 饼图（piepro）

```sql
* | SELECT request_method, count(*) as pv
    GROUP BY request_method ORDER BY pv DESC LIMIT 10
```

### TopN 表（tablepro）

```sql
* | SELECT host, count(*) as pv, approx_distinct(remote_addr) as uv
    GROUP BY host ORDER BY pv DESC LIMIT 20
```

### 日志明细表（tablepro + scan）

```sql
__LEVEL__:ERROR | set session mode=scan;
SELECT date_format(__time__, '%Y-%m-%d %H:%i:%S') as time,
       __source__ as source, __LEVEL__ as level,
       requestId, message
ORDER BY __time__ DESC LIMIT ALL
```

### 过滤器候选值（droplistpro）

```sql
* | SELECT DISTINCT status ORDER BY status
```

### 地图聚合（chinadistrictmap / worlddistrictmap）

```sql
* | SELECT ip_to_province(remote_addr) as province,
         count(*) as pv
    GROUP BY province LIMIT 100
```

```sql
* | SELECT ip_to_country(remote_addr) as country,
         geohash(ip_to_geo(arbitrary(remote_addr))) as geo,
         count(*) as pv
    GROUP BY country HAVING geo <> '' LIMIT 1000
```

### 拓扑图（topologypro）

通常需要两条 `chartQueries`：

边关系查询：

```sql
* | SELECT child_service, parent_service, 'SERVER' as type FROM log
```

节点指标查询：

```sql
* | SELECT service,
         sum(total) as total,
         sum(sum_latency) as sumLatency,
         max(max_latency) as maxLatency
    GROUP BY service
```

### MetricStore 趋势图（metricspro / linepro）

PromQL（`metricstore`）：
```promql
avg by (instance) (rate(http_requests_total[5m]))
```

SQL + PromQL（`metricsql`）：
```sql
* | SELECT time, element_at(labels, 'instance') as instance, value
    FROM (SELECT promql_query_range('avg by (instance) (rate(http_requests_total[5m]))', '60s') FROM metrics)
    LIMIT 10000
```

如果只是普通趋势展示，优先前者，不要默认改写成后者。

## 5. 常见坑

- **过滤条件放错位置**：有索引的过滤条件应放在 `|` 前面（搜索条件），不要全部塞进 SQL 的 `WHERE`
- **`query` 和 `tokenQuery`**：无变量替换时两者相同；有过滤器变量时 `tokenQuery` 保留原始模板，`query` 是替换后的值
- **Scan SQL 不是 SPL**：`set session mode=scan; SELECT ...` 是扫描分析（SQL），`| where ... | project ...` 是扫描查询（SPL），两者语法不同
- **SPL 字段类型**：SPL 中所有字段视为 text，数值比较必须 `cast`
- **MetricStore 表名引号**：SQL 直查时序表，表名 `"{store}.prom"` 的双引号不能省
- **PromQL 返回上限**：`promql_query_range` 最多返回 11,000 个时间点
- **`date_format` 时间列**：如果格式化后的字符串要作为时间轴，建议包含完整日期 `'%Y-%m-%d %H:%i:%S'`；趋势图更稳妥的做法是直接输出数值时间列（如 `__time__ - __time__ % 60`）
- **不要滥用 `field:*`**：很多“字段存在”过滤直接写 `field` 就够了
- **图例命名别只靠 fieldOptions**：对 `metricstore` 趋势图，优先 `legendFormat`
- **单值误判**：PromQL 在控制台返回如果含 `time/value` 多点，默认按趋势图处理，不要先做 `statpro`
- **nested sql 报错**：一旦看到 nested sql，先检查是否把 `metricstore` 不必要地包成了 `metricsql`

## 6. 生成 checklist

生成 `chartQueries.query` 前检查：

- [ ] 搜索条件中的过滤字段是否有索引？无索引字段不能用于 `|` 前的搜索条件
- [ ] `query` 和 `tokenQuery` 是否都已填写？
- [ ] 趋势图的 SQL 是否包含时间列 + 数值列？
- [ ] 地图类查询是否包含地理列 + 数值列？
- [ ] `tablepro` 明细表是否使用了 scan SQL + 显式字段？
- [ ] `metricstore` 查询是否设置了 `interval` 和 `limit`？`metricsql` 中的 `promql_query_range` 是否显式传入了 `step`？
- [ ] `metricstore` 趋势图是否补了 `legendFormat`？
- [ ] PromQL 实际返回 shape 是单值还是 `time/value` 序列？图表类型是否匹配？
- [ ] 稀疏字段过滤的日志趋势，是否需要 `set session mode=scan;`？
- [ ] SQL 中的 `LIMIT` 是否合理？趋势图建议 `LIMIT 10000`
- [ ] 返回列名是否与 `display.queryOptionMap` 中的字段映射一致？
