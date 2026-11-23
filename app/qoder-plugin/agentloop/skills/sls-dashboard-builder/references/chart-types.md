# Chart Types

产品名称与真实 SLS dashboard JSON `type` 的映射。

规则：
- 输出 JSON 时必须使用"真实 JSON type"列的值
- 不要把产品展示名直接写进 `type`
- 如果用户用中文名称描述图表，先映射到真实 `type`

## 映射表

| 产品名 / 口语名 | 真实 JSON `type` | 备注 |
| --- | --- | --- |
| 折线图 / 线图 / 时序折线图 | `linepro` | 高频 |
| 柱状图 / 柱图 | `barpro` | 高频 |
| 饼图 / 环图 | `piepro` | 高频 |
| 表格 / 超级表格 | `tablepro` | 高频 |
| 统计图 / 数字卡片 | `statpro` | 高频 |
| 原始日志 | `rawlog` | 高频 |
| Markdown / 富文本卡片 | `markdownpro` | 高频 |
| 说明文本块 / 静态文本 | `text` | 标准静态说明文本块 |
| 下拉过滤器 / 动态变量 | `droplistpro` | 高频 |
| 流图 / 聚合图 | `aggpro` | |
| 箱线图 | `box` | |
| 仪表盘 / 计量图 | `burgauge` | |
| 拓扑图 | `topologypro` | |
| 雷达图 | `radarchart` | |
| 散点图 | `scatterchart` | |
| 直方图 | `histogram` | |
| Metric / 指标图 | `metricspro` | |
| 交叉表 | `crosstable` | |
| 中国行政区地图 | `chinadistrictmap` | |
| 世界地图 | `worlddistrictmap` | |
| 地理地图 / AMap | `geomappro` | |
| 热力地图 | `heatmappro` | |
| 火焰图 | `flame` | |
| Timeline Pro / 时间线 | `timelinepro` | |
| Timeline / 时间轴 | `timeline` | |
| 轨迹图 | `trajectory` | |
| 词云 | `cloudwordPro` | 大小写敏感 |
| Sankey 图 / 桑基图 | `sankeypro` | |
| LogReduce | `logreduce` | |
| TreeMap / 矩形树图 | `treemappro` | |
| Machine Pro / 时序图 | `timeseriesPro` | 大小写敏感 |
| Facet 图 | `facetPro` | 大小写敏感 |
| 漏斗图 | `funnelpro` | |
| Bill RCA KPI | `billRcaKpiPro` | 大小写敏感 |
| 色块图 / Color Block | `colorblockpro` | |
| 图片图表 | `imagePro` | 大小写敏感 |
| Dashboard Row / 折叠行 | `dashboardrow` | 仅 grid |

## 高频图表

优先使用这些模板：`linepro`, `barpro`, `piepro`, `tablepro`, `statpro`, `rawlog`, `markdownpro`, `droplistpro`

## 大小写敏感类型

以下类型必须保持原样：`cloudwordPro`, `timeseriesPro`, `facetPro`, `billRcaKpiPro`, `imagePro`

## 特殊类型说明

- `droplistpro` — 过滤器组件，需要关注 `display.dropListOption`
- `text` — 标准静态说明文本块，内容在 `display.text`
- `dashboardrow` — 折叠行，宽度通常占满 24 列，仅用于 grid 布局
- `logreduce` — 查询构造有特殊逻辑，仅在用户明确要求时生成
