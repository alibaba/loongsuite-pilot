---
output: dashboard
dashboard:
  name: loongsuite-pilot-ai-coding-events
  displayName: "LoongSuite Pilot AI Coding 事件洞察"
  defaultTimeRange: "-604800s"
  layout: grid
data:
  sources:
    - ai_coding_events
---

# LoongSuite Pilot AI Coding 事件洞察

本报表只分析 `ai_coding_events` 事实表，不依赖 `dept_roster`、`department`、`dept_user` 或客户自定义外表。

全盘公共口径：

- 有效用户事件：`user.id` 非空。
- 活跃用户：当前时间范围内出现过事件的 `user.id` 去重数。
- Token、事件数、AI Agent、模型、供应商、Tool、Skill 和集中度口径遵循 `schema.md` 中的 SQL 原子元素。
- 用户维度只展示 `user_id`；不展示姓名、部门、团队。
- 不生成总在册人数、覆盖率、未产生日志员工列表、部门/团队 TopN。
- Section 行仅作为布局分隔，不需要显式标题、背景或边框；生成 `dashboardrow` 时 `showTitle`、`showBackground`、`showBorder` 均设置为 `false`。

---

## Section: 核心概览

展示当前时间范围内事件事实表的核心用量，不做部门覆盖率统计。

### 活跃用户数

```yaml
intent: stat-card
type: statpro
size: 6x3
format: none
```

基于 `event_user_day`，统计 `user_id` 去重数。

### 事件数

```yaml
intent: stat-card
type: statpro
size: 6x3
format: KMB
```

基于 `event_user_day.events` 汇总。

### 总Token

```yaml
intent: stat-card
type: statpro
size: 6x3
format: KMB
```

基于 `event_user_day.total_tokens` 汇总。

### 单事件平均Token

```yaml
intent: stat-card
type: statpro
size: 6x3
format: none
```

计算 `sum(total_tokens) / nullif(sum(events), 0)`，保留 2 位小数。

---

## Section: 结构分布

### AI Agent Token 占比

```yaml
intent: pie
type: piepro
size: 8x6
```

基于 `event_user_day.agent_type` 聚合总 Token，占比展示。

### 模型 Token 占比

```yaml
intent: pie
type: piepro
size: 8x6
```

基于 `event_user_day.model` 聚合总 Token，占比展示。

### 模型供应商 Token 占比

```yaml
intent: pie
type: piepro
size: 8x6
```

基于 `event_user_day.provider` 聚合总 Token，占比展示。

---

## Section: 趋势

### 每日使用规模趋势

```yaml
intent: line
type: linepro
size: 12x6
```

基于 `event_user_day.t`，展示活跃用户数和事件数。

### 每日 Token 趋势

```yaml
intent: line
type: linepro
size: 12x6
```

基于 `event_user_day.t`，展示输入 Token、输出 Token、总 Token。

### AI Agent 事件趋势

```yaml
intent: grouped-trend
type: aggpro
size: 12x6
aggField: "AI Agent"
yAxisKey: "事件数"
```

按 `t` 和 `agent_type` 聚合事件数。

### Token 使用时段分布

```yaml
intent: bar
type: barpro
size: 12x6
```

基于 `event_user_hour.h` 聚合总 Token；小时维度展示为 `HH:00`。

---

## Section: 用户与模型明细

### 用户 Token 明细

```yaml
intent: top-table
type: tablepro
size: 24x10
```

按 `user_id` 聚合，展示列：用户ID、输入Token、输出Token、总Token、事件数、单事件平均Token、AI Agent、模型。AI Agent 和模型使用去重集合并按字典序展示。

### AI Agent 明细

```yaml
intent: top-table
type: tablepro
size: 12x8
```

按 `agent_type` 聚合，展示列：AI Agent、活跃用户数、事件数、输入Token、输出Token、总Token。

### 模型明细

```yaml
intent: top-table
type: tablepro
size: 12x8
```

按 `model`、`provider` 聚合，展示列：模型、模型供应商、活跃用户数、事件数、输入Token、输出Token、总Token。

---

## Section: Skill & 工具

### Top 10 Skill（调用次数）

```yaml
intent: top-bar
type: barpro
size: 8x8
orientation: horizontal
```

基于 `skill_call.skill_name` 聚合调用次数，过滤空值和 `SKILL`。

### Top 10 Skill（使用人数）

```yaml
intent: top-bar
type: barpro
size: 8x8
orientation: horizontal
```

基于 `skill_call.skill_name` 聚合 `user_id` 去重数，过滤空值和 `SKILL`。

### Top 10 Tool（调用次数）

```yaml
intent: top-bar
type: barpro
size: 8x8
orientation: horizontal
```

基于 `tool_call.tool_name` 聚合调用次数，过滤空值。

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

按 `user_id` 汇总总 Token 后排序，计算贡献最高前 10% 活跃用户的 Token 占比。事件-only 报表不补入 0 Token 的在册员工。

### Top20% Token占比

```yaml
intent: compare-card
type: statpro
size: 6x3
format: none
unit: "%"
```

按 `user_id` 汇总总 Token 后排序，计算贡献最高前 20% 活跃用户的 Token 占比。事件-only 报表不补入 0 Token 的在册员工。

### Token 人群分层占比

```yaml
intent: bar
type: barpro
size: 12x8
```

按活跃用户总 Token 降序排序，分成 `Top 10%`、`10%-20%`、`后80%` 三个互斥分层，展示人数、Token 总量和 Token 占比。

### 每日 Top10/Top20 Token占比

```yaml
intent: line
type: linepro
size: 12x6
```

按天对活跃用户总 Token 排名，计算 Top10% / Top20% Token 占比趋势。窗口函数按 `t` 分区。
