---
output: dashboard
dashboard:
  name: loongsuite-pilot-ai-coding-team
  displayName: "LoongSuite Pilot AI Coding 团队报表"
  defaultTimeRange: "-604800s"
  layout: grid
data:
  sources:
    - ai_coding_events
    - dept_roster
---

# LoongSuite Pilot AI Coding 团队报表

二级部门级团队洞察大盘，从 `dept_name_2`（二级部门）出发，下钻到 `dept_name_3`（三级团队）。

顶部 `dept_name_2` 过滤器用于选择二级部门。选择后，所有图表联动过滤到该二级部门下的团队数据；不选择时展示全部部门的团队数据。

全盘公共口径：

- 只统计在册员工，通过 `dept_user` 与事件表关联，具体 JOIN 和字段口径遵循 `schema.md`。
- 不内置任何特定组织、事业部、外包、测试账号或团队范围过滤。
- 仓库、代码域、特定组织标签等非公共字段不纳入本 spec。
- Skill、Tool、Token、去重人数等公共计算口径遵循 `schema.md`。
- Section 行仅作为布局分隔，不需要显式标题、背景或边框；生成 `dashboardrow` 时 `showTitle`、`showBackground`、`showBorder` 均设置为 `false`。
- 顶部过滤器区域不生成 Section 行，直接放置过滤器和使用提示。

---

## 顶部过滤器

### 部门选择

```yaml
intent: filter
type: droplistpro
size: 8x1
key: dept_name_2
alias: 部门选择
filterType: token
globalFilter: true
showTitle: false
queryTimeRange: "-86400s"
```

从 `dept_user` 中提取过去一天内相关的 `dept_name_2` 去重列表。部门选择控件不显示显式标题。图表 SQL 使用 `${{dept_name_2|}}` 作为可选 token：

```sql
('${{dept_name_2|}}' = '' OR d.dept_name_2 = '${{dept_name_2|}}')
```

### 使用提示

```yaml
intent: text
type: text
size: 16x1
```

静态提示文本：`可选择二级部门查看团队明细；不选择时展示全部团队。`

---

## Section: 核心概览

5 张指标卡片，展示当前时间范围内所选二级部门的核心 KPI。所有卡片都跟随 `dept_name_2` 过滤器联动，不做周同比对比。

### 总人数

```yaml
intent: stat-card
type: statpro
size: 5x3
format: none
```

`dept_user` 中满足部门过滤条件的在册员工去重人数。

### 使用人数

```yaml
intent: stat-card
type: statpro
size: 5x3
format: none
```

`dept_user` JOIN `active_user` 后，统计存在 Agent 事件的去重员工数。

### 覆盖率(%)

```yaml
intent: stat-card
type: statpro
size: 5x3
format: none
unit: "%"
```

`使用人数 / 总人数 * 100`。

### 事件数

```yaml
intent: stat-card
type: statpro
size: 5x3
format: KMB
```

按当前部门过滤条件汇总 `active_user.events`。

### 总Token

```yaml
intent: stat-card
type: statpro
size: 4x3
format: KMB
```

按当前部门过滤条件汇总 `active_user.total_tokens`。

---

## Section: 结构分布

### AI Agent Token 占比

```yaml
intent: pie
type: piepro
size: 8x6
```

按 AI Agent 聚合总 Token，占比展示。

### 模型 Token 占比

```yaml
intent: pie
type: piepro
size: 8x6
```

按模型聚合总 Token，占比展示。

### 模型供应商 Token 占比

```yaml
intent: pie
type: piepro
size: 8x6
```

按模型供应商聚合总 Token，占比展示。

---

## Section: 趋势

### 每日使用规模趋势

```yaml
intent: line
type: linepro
size: 12x6
```

按天聚合，展示使用员工数和 Agent 事件数。

### 每日 Token 趋势

```yaml
intent: line
type: linepro
size: 12x6
```

按天聚合，展示输入 Token、输出 Token、总 Token。

### AI Agent 事件趋势

```yaml
intent: grouped-trend
type: aggpro
size: 12x6
aggField: "AI Agent"
yAxisKey: "事件数"
```

按天和 AI Agent 聚合事件数。

### AI Agent Token 趋势

```yaml
intent: grouped-trend
type: aggpro
size: 12x6
aggField: "AI Agent"
yAxisKey: "总Token"
```

按天和 AI Agent 聚合总 Token。

### Token 使用时段分布

```yaml
intent: bar
type: barpro
size: 24x6
```

按小时聚合总 Token，用于观察使用高峰时段；小时维度展示为 `HH:00`，例如 `09:00`、`18:00`。

---

## Section: 团队统计

按 `dept_name_3`（三级团队）维度展示所选二级部门下的团队差异。

### 团队 Token 明细

```yaml
intent: top-table
type: tablepro
size: 16x8
```

按 `dept_name_3` 聚合，展示列：团队、总人数、使用人数、覆盖率(%)、事件数、输入Token、输出Token、总Token、人均Token。`dept_user` LEFT JOIN `active_user`，按总 Token 降序。

### 未产生日志员工列表

```yaml
intent: top-table
type: tablepro
size: 8x8
```

展示当前部门过滤条件下，在 `dept_user` 中存在但当前时间范围内没有 Agent 事件的员工。展示列：姓名、工号、团队。

### 团队总Token Top10

```yaml
intent: top-bar
type: barpro
size: 8x7
orientation: horizontal
```

按 `dept_name_3` 聚合总 Token，取 Top 10。

### 团队使用覆盖率 Top10

```yaml
intent: top-bar
type: barpro
size: 8x7
orientation: horizontal
```

按 `dept_name_3` 计算使用人数 / 总人数，取覆盖率 Top 10。

### 团队人均Token Top10

```yaml
intent: top-bar
type: barpro
size: 8x7
orientation: horizontal
```

按 `dept_name_3` 计算总 Token / 使用人数，取 Top 10。

---

## Section: 组织与人员

### 员工 Token 明细

```yaml
intent: top-table
type: tablepro
size: 24x12
```

展示当前部门过滤条件下的员工使用明细。展示列：姓名、工号、团队、输入Token、输出Token、总Token、事件数、单事件平均Token、AI Agent、模型。

### AI Agent 明细

```yaml
intent: top-table
type: tablepro
size: 12x8
```

按 AI Agent 聚合，展示列：AI Agent、使用人数、事件数、输入Token、输出Token、总Token。

### 模型明细

```yaml
intent: top-table
type: tablepro
size: 12x8
```

按模型聚合，展示列：模型、模型供应商、使用人数、事件数、输入Token、输出Token、总Token。

---

## Section: Skill & 工具

### Top 10 Skill（调用次数）

```yaml
intent: top-bar
type: barpro
size: 8x8
orientation: horizontal
```

按派生 `skill_name` 聚合调用次数，过滤空值后取 Top 10。

### Top 10 Skill（使用人数）

```yaml
intent: top-bar
type: barpro
size: 8x8
orientation: horizontal
```

按派生 `skill_name` 聚合去重使用人数，过滤空值后取 Top 10。

### Top 10 Tool（调用次数）

```yaml
intent: top-bar
type: barpro
size: 8x8
orientation: horizontal
```

按 `gen_ai.tool.name` 聚合调用次数，过滤空值后取 Top 10。

---

## Section: Token 集中度

### Top10% Token占比

```yaml
intent: compare-card
type: statpro
size: 6x3
format: none
unit: "%"
```

按当前部门过滤条件下的在册员工总 Token 排序，取人数 Top10% 员工贡献的 Token 占比。

### Top20% Token占比

```yaml
intent: compare-card
type: statpro
size: 6x3
format: none
unit: "%"
```

按当前部门过滤条件下的在册员工总 Token 排序，取人数 Top20% 员工贡献的 Token 占比。

### Token 人群分层占比

```yaml
intent: bar
type: barpro
size: 12x9
```

按当前部门过滤条件下有 Token 的员工总 Token 降序排序，按人数百分比分成互斥人群，展示各分层人数、Token 总量和 Token 占比。建议分层：`Top 10%`、`10%-20%`、`后80%`；其中 `10%-20%` 为 Top20% 扣除 Top10%，`后80%` 为剩余员工。

### 每日 Top10/Top20 Token占比

```yaml
intent: line
type: linepro
size: 12x6
```

按天计算 Top10% / Top20% 员工 Token 占比趋势。
