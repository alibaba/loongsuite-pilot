# 筛选器与变量替换

筛选器负责提供输入，查询决定输入如何影响结果。先确定输入要修改原始日志搜索、查询模板还是时序标签，再配置控件。本文集中说明通用机制与 modern JSON；业务字段、枚举和指标口径由上游业务 skill 定义。

## 选择机制与作用范围

| 需求 | 配置方式 | 查询如何响应 |
|---|---|---|
| 按原始日志字段筛选整盘 | `droplistpro`，`dropListOption.type: filter` | 将字段条件追加到搜索部分，即 `搜索条件 | SQL` 的管道之前；字段需在目标 Logstore 中可搜索 |
| 调整 SQL 参数、关联后的维度或查询粒度 | `droplistpro`，`dropListOption.type: token` | 替换各图查询中的同名占位符；没有该占位符的查询不受此变量影响 |
| 只调整一张图的查询参数 | 图表编辑器“变量替换”，`display.innerTokenOption` | 在该图左上方显示控件，仅向该图提供变量 |
| 按时序标签筛选 | 时序过滤器 | 按 MetricStore 的 Label / Value 组合条件，多个条件取交集 |
| 点击结果后打开明细 | [交互事件与下钻报表](drill-down-events.md) | 将点击上下文中的值传给目标变量，或构造目标日志搜索条件 |

`filter` 的 `key` 是原始日志字段名，`token` 的 `key` 是模板变量名，可以与任何物理字段不同。假设部门来自用户事实与组织维表的 JOIN，应通过变量在产生部门字段的 SQL 查询层过滤；在原始搜索中追加 `部门: ...` 不会筛选 JOIN 结果。

`globalFilter: true` 表示不指定 Key、在所有字段中搜索所选值；`false` 表示只搜索指定 Key。它不控制影响哪些图表。图表是否继承仪表盘过滤条件由 `search.isInheritFilter` 等查询配置决定；候选列表查询也有自己的继承设置。

`adhoc` 是另一个即席过滤模式，不与字段过滤、变量替换或时序过滤互换；已有此类控件时保留其数据源和表达式协议。

## 变量语法与查询模板

| 写法 | 含义 |
|---|---|
| `${{key}}` | 使用变量值；没有回退值，执行前必须提供值 |
| `${{key|default}}` | 有值时使用变量值，缺失或空字符串时使用默认文本 |
| `${{key|default|prefix}}` | 有值时使用 `prefix + value`，无值时只使用 `default` |

变量名与控件 Key、下钻目标变量名保持一致。替换是文本操作，不会自动增加 SQL 引号、转换单位或生成 `IN` 列表。默认值与前缀中的空格、引号也是查询文本的一部分。

例如查询按秒聚合，`${{bucket_seconds|60}}` 在未选择时为 `60`，选择 `3600` 后为 `3600`。字符串参数可写为 `WHERE d.dept_id = '${{dept_id}}'`，引号由查询模板提供，变量传原始标识；标识中包含单引号时仍需按 SQL 字符串规则转义。搜索条件、SQL、URL 各有自己的转义规则，不共用一种编码。

前缀适合完整条件的可选替换。例如 `WHERE ${{min_duration|true|duration_ms > }}`：

| 输入状态 | 替换结果 |
|---|---|
| 未设置或空字符串 | `WHERE true` |
| 值为 `1000` | `WHERE duration_ms > 1000` |
| 值为 `0` | `WHERE duration_ms > 0` |

前缀不会附加到默认值上。显示标签“1000ms”应对应替换值 `1000`，不能把 `1000ms` 直接放入数值比较。

对于可直接打开查看全部对象的明细盘，显式约定不筛选的值。例如使用不属于真实部门编码的 `__all__`：

```sql
WHERE ('${{dept_id|__all__}}' = '__all__'
       OR d.dept_id = '${{dept_id|__all__}}')
```

这里假设 `d` 是组织维表别名，条件放在可访问 `d.dept_id` 的查询层。“全部”与字段缺失是不同状态；清空选择的通用约定是移除变量或传空串；字符串 `undefined` 不会触发默认值。宿主存在不同传值协议时，应在接入处明确归一化方式，不能假设它与空值等价。

### `query` 与 `tokenQuery`

`chartQueries[].tokenQuery` 保留模板；`query` 保存当前替换后的可执行查询。没有变量时两者相同。例如默认按分钟聚合：

```json
{
  "name": "A",
  "datasource": "logstore",
  "project": "example-project",
  "logstore": "example-logstore",
  "query": "* | SELECT __time__ - __time__ % 60 AS time, count(*) AS requests GROUP BY time ORDER BY time",
  "tokenQuery": "* | SELECT __time__ - __time__ % ${{bucket_seconds|60}} AS time, count(*) AS requests GROUP BY time ORDER BY time"
}
```

修改 SQL 时同时更新两者，避免界面执行旧查询或后续替换恢复旧模板。搜索、SQL 和 PromQL 的具体写法见 [query-syntax.md](query-syntax.md)。

## 仪表盘变量控件

在仪表盘编辑模式添加过滤器，类型选择“变量替换”，Key 填模板变量名，配置静态或动态候选，保存仪表盘。下面是静态单选的完整控件，可与上面的查询配合使用；布局可按需调整。

```json
{
  "title": "filter-bucket-seconds",
  "type": "droplistpro",
  "search": {
    "chartQueries": [{"name": "A", "datasource": "builtin", "type": "random_time_line"}],
    "isInheritFilter": false,
    "query": "@", "logstore": "@", "topic": "",
    "start": "-900s", "end": "now", "timeSpanType": ""
  },
  "action": {},
  "display": {
    "basicOptions": {
      "displayName": "时间粒度", "showTitle": true,
      "showBorder": true, "showBackground": true, "showTime": false
    },
    "dropListOption": {
      "key": "bucket_seconds", "alias": "时间粒度", "type": "token",
      "showType": "select", "multipleToken": false,
      "tokenKeys": [], "multipleTokenKey": "",
      "list": ["60", "3600"], "listAlias": ["分钟", "小时"],
      "tokenDefault": [true, false]
    },
    "bindQuery": false, "showDropListChart": true,
    "xPos": 0, "yPos": 0, "width": 6, "height": 2, "version": "2"
  }
}
```

`list` 存实际替换值，`listAlias` 按相同索引存显示标签。`tokenDefault` 也是按索引排列的布尔数组，标记默认选项，不是默认值列表。字段过滤的对应属性是 `listDefault`。模板默认值负责变量未提供时的查询行为；控件默认选中负责打开页面时的选中态，两者应一致。

变量可在界面选择自由输入或下拉列表。已知枚举、时间粒度、阈值优先使用候选列表；自由输入仍需满足所在查询位置的类型与语法。

## 原始字段过滤

在上述控件骨架中将 `dropListOption` 替换为以下配置，即可按原始 `status` 字段过滤。目标图表查询启用继承过滤；无需给 SQL 增加同名变量。

```json
{
  "key": "status", "alias": "请求状态", "type": "filter",
  "list": ["ok", "error"], "listAlias": ["成功", "失败"],
  "listDefault": [false, false],
  "globalFilter": false, "autoFilter": false, "logic": "and"
}
```

选择失败后，条件在搜索部分表现为 `status: error`，与原搜索条件组合后再执行 SQL。字段过滤支持多个值，同一字段所选值形成 OR；`logic: and` 与原搜索取交集，`logic: not` 排除所选值。`autoFilter` 用于自动移除数据源中不存在的值，不表示开启继承过滤。

## 动态候选列表

开启动态候选时，设置 `display.bindQuery: true`，在控件自身的 `search.chartQueries` 中配置真实数据源、候选查询与时间范围。例如为 `dept_id` 变量提供候选：

```json
{
  "name": "A",
  "datasource": "logstore",
  "project": "example-project",
  "logstore": "example-roster",
  "query": "* | SELECT DISTINCT dept_id WHERE dept_id IS NOT NULL AND dept_id <> '' ORDER BY dept_id LIMIT 1000",
  "tokenQuery": "* | SELECT DISTINCT dept_id WHERE dept_id IS NOT NULL AND dept_id <> '' ORDER BY dept_id LIMIT 1000"
}
```

此处假设候选表包含 `dept_id`。使用普通单变量 Logstore 下拉控件时，候选原值放在结果第一列；增加第二列中文名称不等于声明“标签列 + 值列”。静态已知字典可用 `list` / `listAlias` 映射候选原值。动态标签或一行更新多个变量属于另一种配置协议，应使用目标控件明确支持的配置。

候选查询的时间范围决定能出现哪些选项；花名册快照与事实数据可能需要不同时间范围。`search.isInheritFilter` 控制候选查询是否受已有过滤影响：启用可联动收窄候选，但要确认继承字段存在于候选数据源，且不会因当前自身筛选导致选项无法切换。

变量多选的替换文本取决于控件的多选格式；字段过滤的 OR 规则不会自动变成 SQL `IN (...)`。需要多选时，先确定查询期望的列表格式与字符串转义，再配置控件并核对实际查询。

## 单图变量

图表编辑器右侧选择“变量替换”，配置 Key、显示名、选项显示名与替换值；查询中仍使用同一占位符。对应的 `display` 片段如下，可复用前面的按时间粒度聚合查询：

```json
{
  "innerTokenOption": [
    {
      "key": "bucket_seconds",
      "alias": "时间粒度",
      "values": [
        {"name": "分钟", "value": "60", "isDefault": true},
        {"name": "小时", "value": "3600", "isDefault": false}
      ]
    }
  ]
}
```

不要同时为整盘和单图创建含义不同的同名变量。需要整盘统一切换时使用整盘控件；需要单图独立调整时使用独立变量名和单图控件，避免依赖同名值的覆盖顺序。

## 与交互事件配合

控件、下钻和宿主 URL 都可以提供变量值，目标查询通过同名模板消费它们。交互的动态变量映射使用“目标变量名 → 源结果列名”，继承变量沿用已有值；仅创建目标控件不会自动建立点击值映射。事件类型、字段绑定、时间继承、SLS 原生配置与 AgentLoop URL 协议集中见 [交互事件与下钻报表](drill-down-events.md)。

## 验证与本地预览

验证对象是实际查询和结果，而不只是控件外观：

1. 首次打开：默认选中态、模板回退值与预期结果一致。
2. 切换选项：实际查询使用原值，所有应响应的卡片、趋势、明细使用相同筛选范围。
3. 清空与重置：恢复约定的全部范围或默认值，不遗留旧条件。
4. 动态候选：切换时间及其他筛选后，选项仍符合数据源与继承规则。
5. 下钻：目标收到点击行的原始标识，保留所需时间范围，查询与结果确实缩小到目标对象。

`render-report --var key=value` 当前只替换查询中的精确 `${{key}}`，不模拟默认值、前缀、下拉选中态、字段过滤、单图变量或跳转。渲染器读取 `chartQueries[].query`；含高级模板时可使用已展开的 `query` 检查该参数下的数据与布局，保留 `tokenQuery` 供线上交互使用。控件、替换过程与跳转仍在实际 SLS 或 AgentLoop 宿主中验收。

## 参考资料

- [添加过滤器筛选仪表盘与添加变量替换筛选图表](https://help.aliyun.com/zh/sls/add-filter)：过滤类型、界面配置、默认值、前缀及单图变量。
- [为仪表盘添加交互事件实现下钻分析](https://help.aliyun.com/zh/sls/drill-down-events)：变量与点击上下文的传递。
