# Chart Templates

高频 9 种图表 + 常用日志表模式的 grid 布局起步模板。

注意：这些模板是为 grid 布局优化的起步配置，不是代码中的原始默认模型（多数普通图表的原始默认模型使用 free 布局坐标 `500x300`，`rawlog` 和 `droplistpro` 是例外，源码默认均为 `300x50`）。`version` 字段统一使用字符串 `"2"`。

使用规则：
- 优先复制模板后按需修改
- `title` 必须替换成唯一值，格式要求：只允许小写字母、数字、`_`、`-`，首尾必须是小写字母或数字，长度 2-100。建议格式：`chart-时间戳-序号`（如 `chart-1710000000000-01`）。不要直接用 mixed-case 的 `type` 做前缀（如 `timeseriesPro` 含大写，不合法）
- `display.basicOptions.displayName` 替换成用户可见标题
- 用户未提供真实数据源时可保留 `builtin` 演示数据
- 所有模板默认使用 grid 布局坐标；free 布局需按 `layout.md` 转换尺寸

## 1. linepro

```json
{
  "title": "chart-1710000000000-01",
  "type": "linepro",
  "search": {
    "topic": "",
    "start": "-900s",
    "end": "now",
    "chartQueries": [
      {
        "name": "A",
        "datasource": "builtin",
        "type": "random_time_line"
      }
    ],
    "logstore": "@",
    "query": "@"
  },
  "action": {},
  "display": {
    "isTimeSeries": false,
    "basicOptions": {
      "displayName": "新建图表",
      "showTitle": true,
      "showBorder": true,
      "showBackground": true,
      "showTime": true
    },
    "standardOption": {
      "format": "none",
      "unit": { "unit": "none" }
    },
    "legendOption": {
      "show": true,
      "position": "right",
      "actionMode": "toggle",
      "maxContent": 30
    },
    "tooltipOption": {
      "mode": "all",
      "sortOrder": "none",
      "labelFormat": ""
    },
    "xAxisOption": {
      "show": true,
      "timeRangeMode": "dataTime",
      "zoomTarget": "global"
    },
    "yAxisOption": {
      "show": true,
      "position": 3,
      "stackingMode": "none"
    },
    "graphOptions": {
      "seriesStyle": "lines",
      "lineInterpolation": "smooth",
      "barStyle": "middle",
      "lineWidth": 1.5,
      "fillOpacity": 40,
      "pointSize": 6,
      "gradientMode": "opacity",
      "showPoint": "none"
    },
    "xPos": 0,
    "yPos": 0,
    "width": 8,
    "height": 9,
    "version": "2"
  }
}
```

## 2. barpro

```json
{
  "title": "chart-1710000000000-02",
  "type": "barpro",
  "search": {
    "topic": "",
    "start": "-900s",
    "end": "now",
    "chartQueries": [
      {
        "name": "A",
        "datasource": "builtin",
        "type": "random_bar"
      }
    ],
    "logstore": "@",
    "query": "@"
  },
  "action": {},
  "display": {
    "isTimeSeries": false,
    "basicOptions": {
      "displayName": "新建图表",
      "showTitle": true,
      "showBorder": true,
      "showBackground": true,
      "showTime": true
    },
    "barOptions": {
      "stackingMode": "none",
      "showValues": "auto",
      "orientation": "vertical",
      "groupWidth": 0.7,
      "barWidth": 0.9,
      "valueSize": 12,
      "lineWidth": 1,
      "fillOpacity": 85,
      "gradientMode": "none",
      "labelLocation": "xAxis"
    },
    "standardOption": {
      "format": "none",
      "unit": { "unit": "none" }
    },
    "legendOption": {
      "show": true,
      "position": "right",
      "actionMode": "toggle",
      "maxContent": 30
    },
    "tooltipOption": {
      "mode": "all",
      "sortOrder": "none"
    },
    "xAxisOption": { "show": true },
    "yAxisOption": { "show": true, "position": 3 },
    "xPos": 0,
    "yPos": 0,
    "width": 8,
    "height": 9,
    "version": "2"
  }
}
```

## 3. piepro

```json
{
  "title": "chart-1710000000000-03",
  "type": "piepro",
  "search": {
    "topic": "",
    "start": "-900s",
    "end": "now",
    "chartQueries": [
      {
        "name": "A",
        "datasource": "builtin",
        "type": "random_bar"
      }
    ],
    "logstore": "@",
    "query": "@"
  },
  "action": {},
  "display": {
    "isTimeSeries": false,
    "basicOptions": {
      "displayName": "新建图表",
      "showTitle": true,
      "showBorder": true,
      "showBackground": true,
      "showTime": true
    },
    "standardOption": {
      "format": "none",
      "unit": { "unit": "none" }
    },
    "legendOption": {
      "show": true,
      "position": "bottom",
      "actionMode": "toggle",
      "maxContent": 30
    },
    "pieOption": {
      "chartType": "PieChart",
      "labelType": "percent",
      "showLabel": true
    },
    "xPos": 0,
    "yPos": 0,
    "width": 8,
    "height": 9,
    "version": "2"
  }
}
```

## 4. tablepro

```json
{
  "title": "chart-1710000000000-04",
  "type": "tablepro",
  "search": {
    "topic": "",
    "start": "-900s",
    "end": "now",
    "chartQueries": [
      {
        "name": "A",
        "datasource": "builtin",
        "type": "random_time_line"
      }
    ],
    "logstore": "@",
    "query": "@"
  },
  "action": {},
  "display": {
    "basicOptions": {
      "displayName": "新建图表",
      "showTitle": true,
      "showBorder": true,
      "showBackground": true,
      "showTime": true
    },
    "standardOption": {
      "format": "none",
      "unit": { "unit": "none" }
    },
    "tableOptions": {
      "showHeader": true,
      "showTotal": true,
      "adaptivedColumn": false,
      "defaultLines": 3,
      "transparentBackground": false,
      "pageSize": 20,
      "rowHeight": 36,
      "showMode": "pagination",
      "showGaugeTitle": true,
      "sortField": "",
      "sortMethod": "default"
    },
    "columnOptions": {
      "closeSearch": false,
      "columnMinWidth": 100,
      "fontSize": 12,
      "closeSort": false,
      "columnAlign": "left",
      "cellMode": "none",
      "searchMode": "search",
      "searchMultiple": true
    },
    "xPos": 0,
    "yPos": 0,
    "width": 8,
    "height": 9,
    "version": "2"
  }
}
```

### 4.1 tablepro（日志样本 / TopN 推荐模板）

当 `tablepro` 用来展示**日志样本、错误明细、TopN 聚合**时，优先使用 `logstore + scan SQL`：

```json
{
  "title": "chart-1710000000000-04a",
  "type": "tablepro",
  "search": {
    "topic": "",
    "start": "-3600s",
    "end": "now",
    "chartQueries": [
      {
        "name": "A",
        "project": "my-project",
        "logstore": "my-logstore",
        "datasource": "logstore",
        "query": "__LEVEL__:ERROR | set session mode=scan; select date_format(__time__, '%Y-%m-%d %H:%i:%S') as time, __source__ as source, __topic__ as topic, __LEVEL__ as level, requestId, errorMessage, message order by __time__ desc limit all",
        "tokenQuery": "__LEVEL__:ERROR | set session mode=scan; select date_format(__time__, '%Y-%m-%d %H:%i:%S') as time, __source__ as source, __topic__ as topic, __LEVEL__ as level, requestId, errorMessage, message order by __time__ desc limit all"
      }
    ],
    "logstore": "my-logstore",
    "query": "@"
  },
  "action": {},
  "display": {
    "basicOptions": {
      "displayName": "错误日志样本",
      "showTitle": true,
      "showBorder": true,
      "showBackground": true,
      "showTime": true
    },
    "standardOption": {
      "format": "none",
      "unit": { "unit": "none" }
    },
    "tableOptions": {
      "showHeader": true,
      "showTotal": true,
      "adaptivedColumn": false,
      "defaultLines": 3,
      "transparentBackground": false,
      "pageSize": 20,
      "rowHeight": 36,
      "showMode": "pagination",
      "showGaugeTitle": true,
      "sortField": "",
      "sortMethod": "default"
    },
    "columnOptions": {
      "closeSearch": false,
      "columnMinWidth": 100,
      "fontSize": 12,
      "closeSort": false,
      "columnAlign": "left",
      "cellMode": "none",
      "searchMode": "search",
      "searchMultiple": true
    },
    "xPos": 0,
    "yPos": 0,
    "width": 8,
    "height": 9,
    "version": "2"
  }
}
```

常见场景：
- 错误日志样本
- 慢请求样本
- TopN 聚合表
- 恢复 / 审计 / 任务明细表

## 5. statpro

```json
{
  "title": "chart-1710000000000-05",
  "type": "statpro",
  "search": {
    "topic": "",
    "start": "-900s",
    "end": "now",
    "chartQueries": [
      {
        "name": "A",
        "datasource": "builtin",
        "type": "random_time_line"
      }
    ],
    "logstore": "@",
    "query": "@"
  },
  "action": {},
  "display": {
    "isTimeSeries": false,
    "basicOptions": {
      "displayName": "新建图表",
      "showTitle": true,
      "showBorder": true,
      "showBackground": true,
      "showTime": true
    },
    "standardOption": {
      "format": "none",
      "unit": { "unit": "none" }
    },
    "statStyleOptions": {
      "textAlignment": "auto",
      "colorMode": "value",
      "graphMode": "none",
      "textMode": "auto",
      "customValueColor": "#333333",
      "customBackgroundColor": "#FFFFFF"
    },
    "statValueOption": {
      "calculationType": "first",
      "limitCount": 25,
      "showMode": "calculate",
      "layoutOrientation": "auto",
      "minItemHeight": 50,
      "minItemWidth": 50
    },
    "thresholdOption": {
      "thresholdMode": "absolute"
    },
    "xPos": 0,
    "yPos": 0,
    "width": 8,
    "height": 9,
    "version": "2"
  }
}
```

## 6. rawlog

```json
{
  "title": "chart-1710000000000-06",
  "type": "rawlog",
  "search": {
    "topic": "",
    "start": "-900s",
    "end": "now",
    "chartQueries": [
      {
        "name": "A",
        "datasource": "builtin",
        "type": "random_time_line"
      }
    ],
    "logstore": "@",
    "query": "@"
  },
  "action": {},
  "display": {
    "basicOptions": {
      "displayName": "原始日志",
      "showTitle": true,
      "showBorder": true,
      "showBackground": true,
      "showTime": false
    },
    "xPos": 0,
    "yPos": 0,
    "width": 8,
    "height": 4,
    "version": "2"
  }
}
```

`rawlog` 的 modern 结构仍使用 `search.chartQueries`；顶层 `query` / `logstore` 仅作兼容字段保留。

## 7. markdownpro

```json
{
  "title": "chart-1710000000000-07",
  "type": "markdownpro",
  "search": {
    "query": "",
    "start": "-900s",
    "topic": "",
    "end": "now",
    "tokens": [],
    "logstore": ""
  },
  "action": {},
  "display": {
    "isTimeSeries": false,
    "markdownStr": "### 标题\n\n内容",
    "basicOptions": {
      "displayName": "Markdown",
      "showTitle": true,
      "showBorder": true,
      "showBackground": true,
      "showTime": true
    },
    "xPos": 0,
    "yPos": 0,
    "width": 8,
    "height": 6,
    "version": "2"
  }
}
```

## 8. droplistpro

```json
{
  "title": "chart-1710000000000-08",
  "type": "droplistpro",
  "search": {
    "chartQueries": [
      {
        "name": "A",
        "datasource": "builtin",
        "type": "random_time_line"
      }
    ],
    "isInheritFilter": false,
    "query": "@",
    "start": "-900s",
    "end": "now",
    "timeSpanType": "",
    "logstore": "@",
    "topic": ""
  },
  "action": {},
  "display": {
    "basicOptions": {
      "displayName": "过滤器",
      "showTitle": true,
      "showBorder": true,
      "showBackground": true,
      "showTime": false
    },
    "dropListOption": {
      "key": "",
      "alias": "",
      "type": "filter",
      "list": [],
      "listAlias": [],
      "globalFilter": false,
      "autoFilter": false,
      "listDefault": [],
      "logic": "and"
    },
    "showDropListChart": true,
    "bindQuery": false,
    "xPos": 0,
    "yPos": 0,
    "width": 6,
    "height": 2,
    "version": "2"
  }
}
```

上方模板展示的是最常见的 `filter` 模式。`dropListOption.type` 还支持 `token`（变量替换）和 `adhoc`（即席过滤）。

`adhoc` 最小结构：

```json
"dropListOption": {
  "key": "",
  "alias": "",
  "type": "adhoc",
  "list": [],
  "listAlias": []
}
```

`adhoc` 模式用于即席过滤场景，生成时按实际需求补充对应字段。

## 9. dashboardrow

```json
{
  "title": "chart-1710000000000-09",
  "type": "dashboardrow",
  "search": {
    "logstore": "",
    "topic": "",
    "query": "",
    "start": "-900s",
    "end": "now"
  },
  "action": {},
  "display": {
    "basicOptions": {
      "displayName": "分组标题"
    },
    "xPos": 0,
    "yPos": 0,
    "width": 24,
    "height": 1,
    "version": "2"
  }
}
```

## queryOptionMap 字段映射

`display.queryOptionMap` 控制查询结果如何映射到图表的轴、图例和数值。key 对应 `chartQueries[].name`（如 `"A"`, `"B"`）。

不同图表类型的结构不同。以下标注了"源码接口"的来自前端 TypeScript 定义，未标注的来自 examples 归纳。

### linepro

```json
"queryOptionMap": {
  "A": {
    "name": "A",
    "xAxisKey": "time",
    "yAxisKeys": ["pv", "uv"]
  }
}
```

- `xAxisKey` — X 轴字段（通常是时间列）
- `yAxisKeys` — Y 轴字段数组，每个字段生成一条线，字段名即图例名

### barpro

```typescript
// 源码接口：BarQueryOption
interface BarQueryOption {
  name: string
  xAxisKey?: string
  yAxisKeys?: string[] | string
  xAxisConcatKeys?: string[]
  aggField?: string
}
```

```json
"queryOptionMap": {
  "A": {
    "name": "A",
    "xAxisKey": "host",
    "yAxisKeys": ["pv", "uv"],
    "xAxisConcatKeys": []
  }
}
```

- `xAxisConcatKeys` — 分组字段，按该字段值拆分成多组柱
- `aggField` — 聚合字段

### piepro

```typescript
// 源码接口：PieQueryOption
interface PieQueryOption {
  name: string
  showFieldKey?: string
  xAxisConcatKeys?: string[]
  numFieldKey?: string
}
```

```json
"queryOptionMap": {
  "A": {
    "name": "A",
    "showFieldKey": "request_method",
    "numFieldKey": "pv",
    "xAxisConcatKeys": []
  }
}
```

- `showFieldKey` — 扇区标签字段（图例名）
- `numFieldKey` — 扇区数值字段

### tablepro

```typescript
// 源码接口：TableProQueryOption
interface TableProQueryOption {
  name: string
  closedKeys?: string[]
}
```

- `closedKeys` — 隐藏的列名数组（不展示但仍查询）
- 基础表格可不配置，但涉及列隐藏、迷你图、进度条、值映射等场景时通常需要配置

### statpro

使用基础 `QueryOption` 接口。通常不需要配置 `queryOptionMap`，默认取查询结果的第一行。源码中未定义独立的 StatQueryOption 接口。

### burgauge

源码中未定义独立的 BurGaugeQueryOption 接口，以下字段来自 examples 归纳：

```json
"queryOptionMap": {
  "A": {
    "showField": ["count"],
    "descriptionDecimals": 2,
    "descriptionFormat": "none",
    "compareUnit": { "unit": "none" },
    "compareValueDescription": ""
  }
}
```

- `showField` — 数值字段数组

### scatterchart

```typescript
// 源码接口：ScatterQueryOption
interface ScatterQueryOption {
  name: string
  xAxisKey?: string
  yAxisKeys?: string[] | string
  sizeKey?: string
  aggField?: string
}
```

```json
"queryOptionMap": {
  "A": {
    "name": "A",
    "xAxisKey": "request_length",
    "yAxisKeys": ["request_time"],
    "sizeKey": "pv"
  }
}
```

- `sizeKey` — 气泡大小字段
- `aggField` — 分组着色字段

### radarchart

```typescript
// 源码接口：RadarQueryOption
interface RadarQueryOption {
  name: string
  showFieldKey?: string
  numFieldKey?: string  // 源码声明为 string，运行时 examples 中常传数组
}
```

```json
"queryOptionMap": {
  "A": {
    "name": "A",
    "numFieldKey": ["pv", "uv", "request_time"],
    "showFieldKey": "request_method"
  }
}
```

- `numFieldKey` — 数值字段（源码声明 string，examples 中实际传数组）
- `showFieldKey` — 分组字段

### crosstable

```typescript
// 源码接口：CrossTableChartQueryOption
interface CrossTableChartQueryOption {
  name: string
  xAxisKeys?: string[]
  yAxisKey?: string
  aggField?: string
}
```

```json
"queryOptionMap": {
  "A": {
    "name": "A",
    "xAxisKeys": ["minute"],
    "yAxisKey": "c",
    "aggField": "request_method"
  }
}
```

- `xAxisKeys` — 行维度字段（数组）
- `yAxisKey` — 数值字段（注意是单数）
- `aggField` — 列维度字段（交叉展开）

### aggpro

```typescript
// 源码接口：AggChartQueryOption
interface AggChartQueryOption {
  name: string
  xAxisKey?: string
  yAxisKey?: string
  aggField?: string
}
```

- `xAxisKey` — 时间轴字段
- `yAxisKey` — 数值字段（单数）
- `aggField` — 聚合分组字段

### histogram

使用基础 `QueryOption` 接口，与 `linepro` 相同：`xAxisKey` + `yAxisKeys`。

### topologypro

拓扑图的 `queryOptionMap` 结构较特殊，通常需要多条 `chartQueries` 分别配置边关系和节点指标。具体映射结构参考 `examples/charts/topologypro/` 中的示例。

### 地图类

#### chinadistrictmap / worlddistrictmap

```typescript
// 源码接口：DistrictMapProQueryOption
interface DistrictMapProQueryOption {
  name: string
  dataType: number  // 0=区域, 1=经纬度
  showFieldKey?: string
  numFieldKey?: string
  longitudeFieldKey?: string
  latitudeFieldKey?: string
  lnglatFieldKey?: string
  adcode?: string
  extraInfo?: string[]
}
```

```json
"queryOptionMap": {
  "A": {
    "name": "A",
    "dataType": 0,
    "showFieldKey": "province",
    "numFieldKey": "pv"
  }
}
```

#### geomappro / heatmappro

```typescript
// 源码接口：HeatMapProQueryOption
interface HeatMapProQueryOption {
  name: string
  longlat?: string
  numFieldKey?: string
}
```

### 通用规则

- `queryOptionMap` 中的字段名必须与 SQL 查询返回的列名一致
- 不设置时图表会尝试自动推断，但结果不可控
- 多查询场景（`"A"` + `"B"`）每个查询各自配置
- `builtin` 数据源不需要配置 `queryOptionMap`

## legendOption 图例配置

```typescript
// 源码接口：LegendOption
interface LegendOption {
  position: 'top' | 'right' | 'bottom' | 'left'
  show: boolean
  actionMode: 'single' | 'toggle'
  maxContent: number
  sortOrder?: 'asc' | 'desc' | 'none'
}
```

```json
"legendOption": {
  "show": true,
  "position": "right",
  "actionMode": "toggle",
  "maxContent": 30,
  "sortOrder": "none"
}
```

| 字段 | 说明 | 可选值 |
| --- | --- | --- |
| `show` | 是否显示图例 | `true` / `false` |
| `position` | 图例位置 | `"top"`, `"right"`, `"bottom"`, `"left"`（源码枚举；examples 中常见 `"right"` 和 `"bottom"`） |
| `actionMode` | 点击交互 | `"toggle"`（切换显隐）, `"single"`（单选）（源码枚举；examples 中常见 `"toggle"`） |
| `maxContent` | 最大显示数量 | 数字，默认 `30` |
| `sortOrder` | 排序方式 | `"asc"`, `"desc"`, `"none"` |

适用图表：`linepro`, `barpro`, `piepro`, `histogram`, `scatterchart`, `radarchart`, `crosstable`

`piepro` 默认 `position: "bottom"`，其他图表默认 `position: "right"`。

## legendFormat 图例格式化

`chartQueries[].legendFormat` 用于格式化 `metricstore` / `metricsql` 查询返回的时序线条名称。

```json
{
  "name": "A",
  "datasource": "metricstore",
  "query": "avg by (instance) (cpu_usage_total{})",
  "tokenQuery": "avg by (instance) (cpu_usage_total{})",
  "legendFormat": "{{instance}}",
  "interval": "60s",
  "limit": 10000
}
```

处理逻辑（源码 `formatLegentFn`）：
- 正则 `/\{\{([\w]+)\}\}/g` 匹配 `{{key}}` 格式
- 将匹配到的 `{{key}}` 替换为 labels JSON 中对应的值；如果 labels 中不存在该 key，替换为空字符串
- 可拼接多个：`{{cluster}}-{{instance}}`
- 可加固定文字：`{{status}}(每分钟)`
- 未配置时，如果存在 `__name__` 则显示 `__name__: {labels}`，否则显示原始 labels 字符串
- 仅对 `metricstore` 和 `metricsql` 数据源有效

## isTimeSeries 时序模式

`display.isTimeSeries` 标识图表是否为时序图表。

```json
"display": {
  "isTimeSeries": true
}
```

- `true` — X 轴按时间戳处理，启用时间轴格式化和缩放
- `false` / 不设置 — X 轴按普通分类处理
- 多数图表类型都支持该字段，不限于 `linepro` 和 `histogram`

## 使用建议

- 新建 dashboard 且用户未给真实查询时，用 `builtin` 模板输出原型
- 修改现有 JSON 时，优先保留原 `search`/`display` 中未知字段，只替换必要部分
- free 布局时，将 grid 尺寸按 `layout.md` 中的建议转换
- 做 KPI 卡片时，优先 `statpro`
- 做多序列指标趋势时，优先 `linepro`；仅在用户明确要求时使用 `metricspro`
- 做日志趋势时，优先 `linepro`
- 做日志样本 / TopN / 明细表时，优先 `tablepro + scan SQL`
- 做过滤器时，优先 `droplistpro`
- 做大盘分段时，优先 `dashboardrow`
